// Explicitly authorized administrator recovery for the installed Twenty.
// Read secrets from stdin, never argv/logs. A verified encrypted PG backup is
// required before apply. No NODE_ENV/auth/role/licensing flags are changed.
const { createRequire } = require('module');
const nativeRequire = createRequire(`${process.cwd()}/package.json`);
const { Client } = nativeRequire('pg');
const crypto = require('crypto');
const assert = require('assert/strict');
const nativeAuth = nativeRequire(`${process.cwd()}/dist/engine/core-modules/auth/auth.util.js`);
const origin = 'https://crm.meludtech.tech';
const sessions = [];
let stage = 'preflight';

async function gql(query, variables, accessToken) {
    const response = await fetch('http://127.0.0.1:3000/metadata', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin,
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(25000),
    });
    const body = await response.json();
    if (!response.ok || body.errors?.length) {
        let safeMessage = String(body.errors?.[0]?.message || '');
        for (const value of Object.values(variables || {})) {
            if (typeof value === 'string' && value) safeMessage = safeMessage.replaceAll(value, '[REDACTED]');
        }
        throw Object.assign(new Error('NATIVE_REQUEST_FAILED'), {
            safeCode: `NATIVE_REQUEST_${response.status}_${body.errors?.[0]?.extensions?.code || 'FAILED'}`,
            safeMessage: safeMessage.slice(0,500),
        });
    }
    return body.data;
}

async function main(input) {
    assert.ok(['apply', 'verify'].includes(input.mode));
    assert.equal(input.userId, '6159f816-c6f8-43b5-861f-7b382f47e870');
    assert.equal(input.workspaceId, '72600089-b4b4-4db3-a8b9-362f07033467');
    assert.equal(input.email, 'admin@ava-platform.ru');
    assert.ok(nativeAuth.PASSWORD_REGEX.test(input.password));
    const db = new Client({ connectionString: process.env.PG_DATABASE_URL });
    await db.connect();
    let resetId;
    try {
        const select = `SELECT u.id,u.email,u.disabled,u."deletedAt",u."canAccessFullAdminPanel",
            w.id AS workspace_id,w."isPasswordAuthEnabled" FROM core."user" u
            JOIN core."userWorkspace" uw ON uw."userId"=u.id
            JOIN core.workspace w ON w.id=uw."workspaceId" WHERE u.id=$1 AND w.id=$2`;
        const params = [input.userId, input.workspaceId];
        const before = (await db.query(select, params)).rows;
        assert.equal(before.length, 1);
        assert.equal(before[0].email, input.email);
        assert.equal(before[0].disabled, false);
        assert.equal(before[0].deletedAt, null);
        assert.equal(before[0].canAccessFullAdminPanel, true);
        assert.equal(before[0].isPasswordAuthEnabled, true);
        const keys = async () => (await db.query(`SELECT md5(COALESCE(
            jsonb_agg(to_jsonb(k) ORDER BY k.id)::text,'[]')) digest FROM core."apiKey" k`)).rows[0].digest;
        const keysBefore = await keys();
        if (input.mode === 'apply') {
            stage = 'reset_token';
            // Offline recovery bootstrap: same SHA-256 opaque reset-token
            // representation as ResetPasswordService, limited to this user and
            // workspace for five minutes. Actual password/session changes run
            // through the standard mutation (password rules + session revoke).
            const resetToken = crypto.randomBytes(32).toString('hex');
            resetId = crypto.randomUUID();
            await db.query('BEGIN');
            await db.query('SELECT id FROM core."user" WHERE id=$1 FOR UPDATE', [input.userId]);
            await db.query(`UPDATE core."appToken" SET "revokedAt"=NOW()
                WHERE "userId"=$1 AND type='PASSWORD_RESET_TOKEN' AND "revokedAt" IS NULL`, [input.userId]);
            await db.query(`INSERT INTO core."appToken"(id,"userId","workspaceId",type,value,"expiresAt")
                VALUES($1,$2,$3,'PASSWORD_RESET_TOKEN',$4,NOW()+INTERVAL '5 minutes')`,
                [resetId,input.userId,input.workspaceId,crypto.createHash('sha256').update(resetToken).digest('hex')]);
            await db.query('COMMIT');
            stage = 'native_password_reset';
            const reset = await gql(`mutation Reset($token:String!,$password:String!){
                updatePasswordViaResetToken(passwordResetToken:$token,newPassword:$password){success}}`,
                { token: resetToken, password: input.password });
            assert.equal(reset.updatePasswordViaResetToken.success, true);
        }
        stage = 'verify_password_hash';
        const hash = (await db.query('SELECT "passwordHash" FROM core."user" WHERE id=$1', [input.userId])).rows[0].passwordHash;
        assert.equal(await nativeAuth.compareHash(input.password, hash), true);
        stage = 'password_sign_in';
        const login = await gql(`mutation Login($email:String!,$password:String!){signIn(email:$email,password:$password){
            tokens{accessOrWorkspaceAgnosticToken{token} refreshToken{token}}
            availableWorkspaces{availableWorkspacesForSignIn{id displayName loginToken}}}}`,
            { email: input.email, password: input.password });
        sessions.push(login.signIn.tokens.refreshToken.token);
        const workspace = login.signIn.availableWorkspaces.availableWorkspacesForSignIn.find(w => w.id === input.workspaceId);
        assert.ok(workspace?.loginToken);
        stage = 'enter_workspace';
        const entered = await gql(`mutation Enter($token:String!,$origin:String!){getAuthTokensFromLoginToken(loginToken:$token,origin:$origin){
            tokens{accessOrWorkspaceAgnosticToken{token} refreshToken{token}}}}`, { token: workspace.loginToken, origin });
        const pair = entered.getAuthTokensFromLoginToken.tokens;
        sessions.push(pair.refreshToken.token);
        stage = 'verify_owner';
        const identity = await gql('{currentUser{id email canAccessFullAdminPanel}}', {}, pair.accessOrWorkspaceAgnosticToken.token);
        assert.equal(identity.currentUser.id, input.userId);
        assert.equal(identity.currentUser.email, input.email);
        assert.equal(identity.currentUser.canAccessFullAdminPanel, true);
        assert.deepEqual((await db.query(select, params)).rows, before);
        assert.equal(await keys(), keysBefore);
        return { success:true, user_id:input.userId, email:input.email, workspace_id:workspace.id,
            workspace:workspace.displayName, password_verified:true, authenticated_owner:true,
            api_keys_unchanged:true, user_roles_unchanged:true, mode:input.mode };
    } finally {
        for (const token of sessions) {
            await gql('mutation Logout($token:String!){signOut(refreshToken:$token)}', {token});
        }
        if (resetId) await db.query('UPDATE core."appToken" SET "revokedAt"=COALESCE("revokedAt",NOW()) WHERE id=$1', [resetId]);
        await db.end();
    }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; if (raw.length > 8192) process.exit(2); });
process.stdin.on('end', async () => {
    try { console.log(JSON.stringify(await main(JSON.parse(raw)))); }
    catch (error) { console.log(JSON.stringify({success:false,stage,error_code:error.safeCode || error.code || 'OWNER_RESET_CHECK_FAILED',message:error.safeMessage})); process.exitCode=1; }
});
