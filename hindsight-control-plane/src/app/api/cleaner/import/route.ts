import { NextRequest, NextResponse } from "next/server";
import { importService, planView, operationView } from "@/lib/cleaner-import";
import { validBank } from "@/lib/cleaner-jobs";
export const runtime = "nodejs";
const LIMIT = 16 * 1024;
function permitted(request: NextRequest) {
  try {
    const url=new URL(`${request.nextUrl.protocol}//${request.headers.get('host')||request.nextUrl.host}`);
    const origin=request.headers.get('origin');const site=request.headers.get('sec-fetch-site');
    return ['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&(!origin||origin===url.origin)&&(!site||['same-origin','none'].includes(site));
  }catch{return false;}
}
const fail=(message:string,status=400)=>NextResponse.json({error:message},{status});
async function body(request:NextRequest) {
  if(!request.body)throw new Error('Empty input');const reader=request.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
  try{while(true){const result=await reader.read();if(result.done)break;bytes+=result.value.length;if(bytes>LIMIT)throw new Error('Input too large');chunks.push(result.value);}}finally{await reader.cancel().catch(()=>undefined);}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}
export async function POST(request:NextRequest) {
  if(!permitted(request))return fail('Import is restricted to same-origin loopback requests.',403);
  if(Number(request.headers.get('content-length'))>LIMIT)return fail('Import request exceeds 16 KiB.',413);
  try {
    const input=await body(request);
    if(input.action==='plan') {
      if(!validBank(input.bank_id)||typeof input.job_id!=='string')return fail('Choose an explicit bank-source job.');
      return NextResponse.json(await importService.prepare(input.job_id,input.bank_id,input.document_indexes));
    }
    if(typeof input.plan_id!=='string')return fail('Choose an existing plan.');
    const plan=await importService.get(input.plan_id);if(!plan)return fail('Saved import plan not found.',404);
    if(input.action==='cancel') {await importService.cancel(input.plan_id);return NextResponse.json(operationView(plan));}
    if(input.action==='rollback_plan') {if(!validBank(input.bank_id))return fail('Choose an explicit bank.');return NextResponse.json(await importService.rollbackPlan(input.plan_id,input.bank_id));}
    if(!['confirm','resume','reconcile','retry'].includes(input.action))return fail('Unsupported import action.');
    if(typeof input.bank_confirmation!=='string'||typeof input.plan_hash!=='string'||typeof input.confirmation_token!=='string'||input.acknowledged!==true)return fail('Confirm the exact bank, plan hash, token and review acknowledgment.');
    return NextResponse.json(await importService.confirm(input.plan_id,{bank_confirmation:input.bank_confirmation,plan_hash:input.plan_hash,confirmation_token:input.confirmation_token,acknowledged:input.acknowledged},input.action==='reconcile'),{status:202});
  }catch{return fail('Import plan or confirmation could not be validated. Sources remain preserved; a verified conditional-create guard is required for writes.',409);}
}
export async function GET(request:NextRequest) {
  if(!permitted(request))return fail('Loopback access only.',403);
  const id=request.nextUrl.searchParams.get('plan');const bank=request.nextUrl.searchParams.get('bank_id');const job=request.nextUrl.searchParams.get('job');
  if(bank&&!validBank(bank))return fail('Choose an explicit bank.');
  const plan=id?await importService.get(id):bank&&job?await importService.latest(job,bank):undefined;
  if(!plan)return fail('Saved import plan not found.',404);
  if(bank&&bank!==plan.bank_id)return fail('Saved plan bank boundary mismatch.',403);
  return NextResponse.json({plan:planView(plan),operation:operationView(plan)},{headers:{'Cache-Control':'no-store'}});
}
