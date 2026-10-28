// Run only after explicit owner authorization and an encrypted DB backup.
// Credentials are generated locally and sent over SSH stdin, not argv/env.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2];
if (!['--confirm-reset','--verify-only'].includes(mode)) throw new Error('Explicit mode required');
const dir = path.join(os.homedir(), 'AVA-Backups/203.0.113.10/access');
fs.mkdirSync(dir, {recursive:true,mode:0o700});
const file = path.join(dir,'twenty-owner-20260908.json');
const handoff = path.join(dir,'AVA-CRM-вход-20260908.txt');
let credential;
if (mode === '--confirm-reset') {
    credential = {url:'https://crm.meludtech.tech',email:'admin@ava-platform.ru',
        password:crypto.randomBytes(24).toString('base64url')+'A7!',verified:false};
    fs.writeFileSync(file,JSON.stringify(credential,null,2)+'\n',{flag:'wx',mode:0o600});
} else {
    if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error('Credential permissions must be 0600');
    credential=JSON.parse(fs.readFileSync(file,'utf8'));
}
const args=['-B','en0','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','IdentitiesOnly=yes',
    '-o','ControlMaster=auto','-o','ControlPersist=600','-o','ControlPath=/tmp/ava-new-move-%C',
    '-i',path.join(os.homedir(),'.ssh/ava-deploy-ed25519'),'root@203.0.113.10',
    'docker exec -i -w /app/packages/twenty-server ava-twenty-server-1 node /tmp/ava-reset-twenty-owner.cjs'];
const run=spawnSync('ssh',args,{input:JSON.stringify({mode:mode==='--confirm-reset'?'apply':'verify',
    userId:'6159f816-c6f8-43b5-861f-7b382f47e870',workspaceId:'72600089-b4b4-4db3-a8b9-362f07033467',
    email:credential.email,password:credential.password}),encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
let result;
try {result=JSON.parse(run.stdout.trim().split('\n').at(-1));} catch {result={success:false,error_code:'RESET_STATUS_UNCERTAIN_VERIFY_ONLY'};}
if (run.status!==0 || result.success!==true) {
    console.log(JSON.stringify({success:false,error_code:result.error_code,stage:result.stage,message:result.message,credential_file:file,
        next_action:'Use --verify-only; never generate another password after an uncertain result.'}));
    process.exitCode=1;
} else {
    credential.verified=true;
    credential.verifiedAt=new Date().toISOString();
    fs.writeFileSync(file,JSON.stringify(credential,null,2)+'\n',{mode:0o600});
    fs.writeFileSync(handoff,`AVA CRM — данные входа\n\nАдрес: ${credential.url}\nЛогин: ${credential.email}\nПароль: ${credential.password}\n\nПространство: AVA Hotels\nВход владельца проверен: ${credential.verifiedAt}\n\nПароль от других модулей AVA не менялся. Сохраните пароль в менеджер паролей.\n`,{mode:0o600});
    console.log(JSON.stringify({...result,credential_file:handoff,secrets_printed:false}));
}
