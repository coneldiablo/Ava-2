
'use strict';
const express=require('express');
const Identity=require('../services/identity/identity-store');
const Delivery=require('../services/identity/team-invitation-delivery');
const CustomerAccess=require('../services/identity/customer-access');
const {getPublicUrl}=require('../services/identity/public-url');
const {teamRoles}=require('../services/identity/role-policy');
const router=express.Router();
const allowed=new Set(['ACCOUNT_NOT_ACTIVE','BUSINESS_SCOPE_REQUIRED','BUSINESS_ACCESS_DENIED','BUSINESS_NOT_FOUND',
    'CAPABILITY_DENIED','INVITATION_INVALID','ACCOUNT_ALREADY_EXISTS','ACCOUNT_ALREADY_MEMBER','TEAM_ORIGIN_REQUIRED',
    'TEAM_SELF_ACCESS_PROTECTED','TEAM_LAST_OWNER','TEAM_ROLE_INVALID','TEAM_MEMBER_NOT_FOUND','INVITATION_RESEND_COOLDOWN','INVITATION_IN_PROGRESS','TEAM_ENROLLMENT_RECONCILIATION_REQUIRED']);
function respondError(res,error) { const code=error.code || error.message;return res.status(error.statusCode || 503).json({success:false,code:allowed.has(code)?code:'TEAM_UNAVAILABLE'}); }
function guard(req,res,next) {
    try {
        if (!req.auth?.userId && req.auth?.platformRole!=='platform_admin') throw Object.assign(new Error('ACCOUNT_NOT_ACTIVE'),{code:'ACCOUNT_NOT_ACTIVE',statusCode:403});
        req.teamBusinessId=Identity.authorizeCapability(req.auth,req.params.businessId,req.method==='GET'?'team.read':'team.manage');
        if (req.method!=='GET' && (req.get('origin')!==getPublicUrl().origin || (req.get('sec-fetch-site') && req.get('sec-fetch-site')!=='same-origin'))) throw Object.assign(new Error('TEAM_ORIGIN_REQUIRED'),{code:'TEAM_ORIGIN_REQUIRED',statusCode:403});
        res.setHeader('Cache-Control','no-store'); next();
    } catch(error) { respondError(res,error); }
}
function body(req,keys) {
    if (!req.body || typeof req.body!=='object' || Array.isArray(req.body) || Object.keys(req.body).some(key=>!keys.includes(key))) throw Object.assign(new Error('INVITATION_INVALID'),{code:'INVITATION_INVALID',statusCode:400});
    return req.body;
}
function invitationResponse(res,result,status=200) {
    const url=new URL('/invite',getPublicUrl());url.hash=result.token;
    return res.status(status).json({success:true,invitationId:result.invitationId,inviteUrl:url.href,expiresAt:result.expiresAt,delivery:result.delivery});
}
router.get('/businesses/:businessId/team',guard,(req,res)=>{
    try { res.json({success:true,businessId:req.teamBusinessId,business_id:req.teamBusinessId,...Identity.listBusinessTeam(req.auth,req.teamBusinessId)}); }
    catch(error) { respondError(res,error); }
});
router.post('/businesses/:businessId/team/invitations',guard,async(req,res)=>{
    try { const input=body(req,['email','displayName','role','businessId','business_id']);
        if ((input.role!==undefined && !teamRoles.includes(input.role)) || ['businessId','business_id'].some(key=>input[key]!==undefined && Number(input[key])!==req.teamBusinessId)) throw Object.assign(new Error('INVITATION_INVALID'),{code:'INVITATION_INVALID',statusCode:400});
        const result=Identity.inviteBusinessMember(req.auth,req.teamBusinessId,input);
        result.delivery=await Delivery.send(req.auth,req.teamBusinessId,result);
        CustomerAccess.reauthorize(req,req.teamBusinessId,'team.manage');
        invitationResponse(res,result,201);
    } catch(error) { respondError(res,error); }
});
router.patch('/businesses/:businessId/team/members/:userId',guard,(req,res)=>{
    try { const input=body(req,['role']);Identity.changeBusinessRole(req.auth,req.teamBusinessId,req.params.userId,input.role);
        res.json({success:true,native_revocation_pending:true}); } catch(error) { respondError(res,error); }
});
router.delete('/businesses/:businessId/team/members/:userId',guard,(req,res)=>{
    try { Identity.removeBusinessMember(req.auth,req.teamBusinessId,req.params.userId);res.json({success:true,local_access_revoked:true,native_revocation_pending:true}); }
    catch(error) { respondError(res,error); }
});
for (const action of ['renew','resend']) router.post(`/businesses/:businessId/team/invitations/:id/${action}`,guard,async(req,res)=>{
    try {
        const result=Identity.renewBusinessInvitation(req.auth,req.teamBusinessId,req.params.id);
        result.delivery=await Delivery.send(req.auth,req.teamBusinessId,result);
        CustomerAccess.reauthorize(req,req.teamBusinessId,'team.manage');
        invitationResponse(res,result);
    } catch(error) { respondError(res,error); }
});
router.delete('/businesses/:businessId/team/invitations/:id',guard,(req,res)=>{
    try { Identity.revokeBusinessInvitation(req.auth,req.teamBusinessId,req.params.id);res.json({success:true}); } catch(error) { respondError(res,error); }
});
module.exports=router;
