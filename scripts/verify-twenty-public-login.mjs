// Read the existing private credential file; never reset, log or pass the secret
// in argv. Real TLS requests use pinned, DNS-verified public hostnames.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const allowed = new Set(['https://crm.meludtech.tech', 'https://app.crm.meludtech.tech',
    'https://ava-hotels.crm.meludtech.tech']);
const loginUrl = process.argv[2] || 'https://app.crm.meludtech.tech';
const workspaceUrl = process.argv[3] || 'https://ava-hotels.crm.meludtech.tech';
assert(allowed.has(loginUrl) && allowed.has(workspaceUrl));
const credentialFile = path.join(os.homedir(),'AVA-Backups/203.0.113.10/access/twenty-owner-20260908.json');
assert.equal(fs.statSync(credentialFile).mode & 0o077, 0);
const credential = JSON.parse(fs.readFileSync(credentialFile,'utf8'));
const sessions = [];
let stage = 'sign_in';
function gql(origin, query, variables = {}, accessToken) {
    // curl config carries the bearer token on stdin together with body content,
    // so neither password nor bearer appears in process arguments.
    const config = [
        `url = "${origin}/metadata"`, 'request = "POST"',
        'header = "Content-Type: application/json"', `header = "Origin: ${origin}"`,
        ...(accessToken ? [`header = "Authorization: Bearer ${accessToken}"`] : []),
        `data = ${JSON.stringify(JSON.stringify({query,variables}))}`,
    ].join('\n');
    const host = new URL(origin).hostname;
    const run = spawnSync('curl', ['--config','-', '--interface','en0','--noproxy','*',
        '--resolve',`${host}:443:203.0.113.10`, '--connect-timeout','8','--max-time','25','--silent','--show-error'],
        {input:config,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
    if (run.status !== 0) throw new Error('PUBLIC_HTTPS_TRANSPORT_FAILED');
    let body;
    try { body=JSON.parse(run.stdout); } catch { throw new Error('PUBLIC_RESPONSE_INVALID'); }
    if (body.errors?.length || !body.data) {
        // Native messages may reflect request data. Print only controlled code.
        const code=String(body.errors?.[0]?.extensions?.code || 'FAILED');
        throw new Error(`NATIVE_${/^[A-Z0-9_]+$/.test(code)?code:'FAILED'}`);
    }
    return body.data;
}
try {
    const login=gql(loginUrl,`mutation Login($email:String!,$password:String!){signIn(email:$email,password:$password){
      tokens{accessOrWorkspaceAgnosticToken{token} refreshToken{token}}
      availableWorkspaces{availableWorkspacesForSignIn{id displayName loginToken}}}}`,
      {email:credential.email,password:credential.password}).signIn;
    sessions.push({origin:loginUrl,token:login.tokens.refreshToken.token});
    const workspace=login.availableWorkspaces.availableWorkspacesForSignIn.find(
        item=>item.id==='72600089-b4b4-4db3-a8b9-362f07033467');
    assert(workspace?.loginToken);
    stage='enter_workspace';
    const entered=gql(workspaceUrl,`mutation Enter($token:String!,$origin:String!){
      getAuthTokensFromLoginToken(loginToken:$token,origin:$origin){tokens{
        accessOrWorkspaceAgnosticToken{token} refreshToken{token}}}}`,
      {token:workspace.loginToken,origin:workspaceUrl}).getAuthTokensFromLoginToken.tokens;
    sessions.push({origin:workspaceUrl,token:entered.refreshToken.token});
    stage='verify_owner';
    const user=gql(workspaceUrl,'{currentUser{id email canAccessFullAdminPanel}}',{},
      entered.accessOrWorkspaceAgnosticToken.token).currentUser;
    assert.equal(user.id,'6159f816-c6f8-43b5-861f-7b382f47e870');
    assert.equal(user.email,credential.email);
    assert.equal(user.canAccessFullAdminPanel,true);
    console.log(JSON.stringify({success:true,login_url:loginUrl,workspace_url:workspaceUrl,
      workspace_id:workspace.id,authenticated_owner:true,tls_verified:true,password_reset:false}));
} catch(error) {
    console.log(JSON.stringify({success:false,stage,error_code:/^[A-Z0-9_]+$/.test(error.message)?error.message:'OWNER_VERIFICATION_FAILED'}));
    process.exitCode=1;
} finally {
    for (const session of sessions) {
        try { gql(session.origin,'mutation Logout($token:String!){signOut(refreshToken:$token)}',{token:session.token}); }
        catch { console.log(JSON.stringify({success:false,error_code:'CONTROL_SESSION_LOGOUT_FAILED'})); process.exitCode=1; }
    }
}
