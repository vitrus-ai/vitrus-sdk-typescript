/** Public, latest-only camera frames from the Vitrus dataplane. */
import type {CameraCaptureProfile,CameraFrame,CameraOutputProfile,DroidRef} from './droid.js';

/**
 * A consumer-local rendition request. These fields never reconfigure the
 * shared camera source; the public service may deliver a lower truthful
 * rendition when the source cannot satisfy a request.
 */
export type CameraObservationOptions={
 signal?:AbortSignal;
 reconnect?:boolean;
 reconnectDelayMs?:number;
 fetch?:typeof globalThis.fetch;
 width?:number;
 height?:number;
 quality?:number;
 maxFps?:number;
 requireExactResolution?:boolean;
};
export type ObserveCameraFramesOptions={endpoint:string;apiKey:string;ref:DroidRef;camera:string}&CameraObservationOptions;
export type LiveCameraFrame=CameraFrame&{bytes:Uint8Array;receivedAtMs:number};
export type CameraStreamErrorDetails={
 code:string;
 status?:number;
 message:string;
 camera?:string;
 requestedProfile?:CameraOutputProfile;
 actualDeliveryProfile?:CameraOutputProfile;
 actualSourceProfile?:CameraCaptureProfile;
 sourceProfileEpoch?:string|number;
};
/** A definite, server-emitted live-camera failure; it is never reconnectable media expiry. */
export class CameraStreamError extends Error{
 readonly code:string;readonly status?:number;readonly camera?:string;
 readonly requestedProfile?:CameraOutputProfile;readonly actualDeliveryProfile?:CameraOutputProfile;
 readonly actualSourceProfile?:CameraCaptureProfile;readonly sourceProfileEpoch?:string|number;
 constructor(details:CameraStreamErrorDetails){
  super(`Vitrus live camera stream error (${details.code}${details.status===undefined?'':`/${details.status}`}): ${details.message}`);
  this.name='CameraStreamError';this.code=details.code;this.status=details.status;this.camera=details.camera;
  this.requestedProfile=details.requestedProfile;this.actualDeliveryProfile=details.actualDeliveryProfile;
  this.actualSourceProfile=details.actualSourceProfile;this.sourceProfileEpoch=details.sourceProfileEpoch;
 }
}
type FetchRequest=(input:Parameters<typeof globalThis.fetch>[0],init?:Parameters<typeof globalThis.fetch>[1])=>Promise<Response>;
const MAX_FRAME_BYTES=1_500_000;
// A public line can contain a maximum-size base64 JPEG plus its small JSON
// envelope.  Retain at most one incomplete line while waiting for a newline:
// this keeps a malformed or stalled peer from growing the SDK heap without
// bound.  Normal frames are consumed immediately and the iterator's natural
// backpressure leaves Bridge's depth-one queue as the only pending frame.
const MAX_NDJSON_BUFFER_BYTES=Math.ceil(MAX_FRAME_BYTES*4/3)+64*1024;

function serialRef(ref:DroidRef):string{
 if(typeof ref==='string'){if(ref.trim())return ref.trim();throw Error('camera.observeFrames requires a Droid serialNumber or alias reference');}
 const candidate=ref.serialNumber??ref.alias;
 if(candidate?.trim())return candidate.trim();
 throw Error('camera.observeFrames requires a Droid serialNumber or alias reference');
}
function decodeFrame(value:string):Uint8Array{
 if(!value||value.length>MAX_FRAME_BYTES*4/3+8)throw Error('live camera frame exceeds the public size bound');
 let binary:string;
 try{binary=atob(value);}catch{throw Error('live camera frame has invalid base64');}
 if(!binary.length||binary.length>MAX_FRAME_BYTES)throw Error('live camera frame exceeds the public size bound');
 const bytes=new Uint8Array(binary.length);for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);return bytes;
}
function positiveInteger(value:unknown,name:string,maximum:number):number{
 if(typeof value!=="number"||!Number.isInteger(value)||value<1||value>maximum)throw Error(`live camera frame has invalid ${name}`);return value;
}
function positiveFinite(value:unknown,name:string):number{
 if(typeof value!=="number"||!Number.isFinite(value)||value<=0)throw Error(`live camera frame has invalid ${name}`);return value;
}
function sourceProfile(value:unknown):CameraCaptureProfile|undefined{
 if(value===undefined)return undefined;
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("live camera frame has invalid actualSourceProfile");
 const profile=value as Record<string,unknown>;
 const fourcc=profile.fourcc;
 if(fourcc!==undefined&&(typeof fourcc!=="string"||!/^[A-Za-z0-9]{4}$/.test(fourcc)))throw Error("live camera frame has invalid source fourcc");
 return {width:positiveInteger(profile.width,"source width",4096),height:positiveInteger(profile.height,"source height",4096),fps:positiveFinite(profile.fps,"source fps"),...(typeof fourcc==="string"?{fourcc}:{})};
}
function outputProfile(value:unknown):CameraOutputProfile|undefined{
 if(value===undefined)return undefined;
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("live camera frame has invalid output profile");
 const profile=value as Record<string,unknown>;
 const width=profile.width,height=profile.height,quality=profile.quality,fps=profile.fps,maxFps=profile.maxFps;
 if(width!==undefined)positiveInteger(width,"output width",4096);
 if(height!==undefined)positiveInteger(height,"output height",4096);
 if(quality!==undefined)positiveInteger(quality,"output quality",100);
 if(fps!==undefined)positiveInteger(fps,"output fps",30);
 if(maxFps!==undefined)positiveInteger(maxFps,"output maxFps",30);
 if(width===undefined&&height===undefined&&quality===undefined&&fps===undefined&&maxFps===undefined)throw Error("live camera frame has empty output profile");
 return {
  ...(typeof width==="number"?{width}:{}),...(typeof height==="number"?{height}:{}),
  ...(typeof quality==="number"?{quality}:{}),...(typeof fps==="number"?{fps}:{}),
  ...(typeof maxFps==="number"?{maxFps}:{}),
 };
}
function stringValue(value:unknown):string|undefined{return typeof value==='string'&&value.trim()?value.trim():undefined;}
function parseSourceProfileEpoch(value:unknown):string|number|undefined{return typeof value==='string'||typeof value==='number'?value:undefined;}
function serverError(value:Record<string,unknown>):CameraStreamError{
 const code=stringValue(value.code)??stringValue(value.error);
 if(!code)throw Error('live camera stream error has no code');
 const rawStatus=value.statusCode??value.status??value.httpStatus??value.http_status;
 if(rawStatus!==undefined&&(!Number.isInteger(rawStatus)||typeof rawStatus!=="number"||rawStatus<100||rawStatus>599))throw Error('live camera stream error has invalid status');
 const requestedProfile=outputProfile(value.requestedProfile);
 const actualDeliveryProfile=outputProfile(value.actualDeliveryProfile??value.outputProfile);
 const actualSourceProfile=sourceProfile(value.actualSourceProfile);
 const epoch=parseSourceProfileEpoch(value.sourceProfileEpoch);
 if(value.sourceProfileEpoch!==undefined&&epoch===undefined)throw Error('live camera stream error has invalid sourceProfileEpoch');
 return new CameraStreamError({code,status:rawStatus as number|undefined,message:stringValue(value.message)??stringValue(value.detail)??code,...(stringValue(value.camera)?{camera:stringValue(value.camera)}:{}),...(requestedProfile?{requestedProfile}:{}),...(actualDeliveryProfile?{actualDeliveryProfile}:{}),...(actualSourceProfile?{actualSourceProfile}:{}),...(epoch===undefined?{}:{sourceProfileEpoch:epoch})});
}
function optionInteger(value:number|undefined,name:string,maximum:number):number|undefined{
 if(value===undefined)return undefined;
 if(!Number.isInteger(value)||value<1||value>maximum)throw new RangeError(`camera observation ${name} is out of range`);
 return value;
}
function parseFrame(value:unknown):LiveCameraFrame|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('live camera stream returned invalid JSON');
 const frame=value as Record<string,unknown>;
 if(frame.type!=='frame')return undefined;
 const camera=typeof frame.camera==='string'?frame.camera:'';
 const frameId=typeof frame.frameId==='string'?frame.frameId:'';
 const capturedAt=typeof frame.capturedAt==='string'?frame.capturedAt:'';
 const mimeType=typeof frame.mimeType==='string'?frame.mimeType:'';
 const dataBase64=typeof frame.dataBase64==='string'?frame.dataBase64:'';
 const receivedAtMs=typeof frame.receivedAtMs==='number'&&Number.isFinite(frame.receivedAtMs)?frame.receivedAtMs:NaN;
 if(!camera||!frameId||!capturedAt||mimeType!=='image/jpeg'||!Number.isFinite(receivedAtMs))throw Error('live camera frame has invalid metadata');
 if(!Number.isFinite(Date.parse(capturedAt)))throw Error('live camera frame has invalid capturedAt');
 const requestedProfile=outputProfile(frame.requestedProfile);
 const actualDeliveryProfile=outputProfile(frame.actualDeliveryProfile??frame.outputProfile);
 const actualSourceProfile=sourceProfile(frame.actualSourceProfile);
 const sourceProfileEpoch=parseSourceProfileEpoch(frame.sourceProfileEpoch);
 if(frame.sourceProfileEpoch!==undefined&&sourceProfileEpoch===undefined)throw Error('live camera frame has invalid sourceProfileEpoch');
 if(frame.resolutionLimitedBySource!==undefined&&typeof frame.resolutionLimitedBySource!=="boolean")throw Error('live camera frame has invalid resolutionLimitedBySource');
 return {camera,frameId,capturedAt,mimeType,dataBase64,bytes:decodeFrame(dataBase64),receivedAtMs,...(typeof frame.width==='number'?{width:frame.width}:{}),...(typeof frame.height==='number'?{height:frame.height}:{}),...(requestedProfile?{requestedProfile}:{}),...(actualDeliveryProfile?{actualDeliveryProfile}:{}),...(actualSourceProfile?{actualSourceProfile}:{}),...(sourceProfileEpoch===undefined?{}:{sourceProfileEpoch}),...(typeof frame.resolutionLimitedBySource==='boolean'?{resolutionLimitedBySource:frame.resolutionLimitedBySource}:{})};
}
const pause=(ms:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
 if(signal?.aborted){reject(signal.reason??new DOMException('Aborted','AbortError'));return;}
 const timer=setTimeout(resolve,ms);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason??new DOMException('Aborted','AbortError'));},{once:true});
});

/**
 * Opens only `GET /v1/droids/cameras/live` on the public dataplane. The server
 * bounds each stream to 60 seconds; this iterator reconnects with the same
 * Bearer credential unless `reconnect:false` or its caller aborts it.
 */
export async function* observeCameraFrames(config:ObserveCameraFramesOptions):AsyncGenerator<LiveCameraFrame>{
 const endpoint=config.endpoint.replace(/\/+$/,'');if(!endpoint)throw Error('camera.observeFrames requires a dataplane endpoint');
 const apiKey=config.apiKey.trim();if(!apiKey)throw Error('camera.observeFrames requires apiKey');
  const ref=serialRef(config.ref),fetchImpl:FetchRequest=config.fetch??((input,init)=>globalThis.fetch(input,init));
 const width=optionInteger(config.width,'width',4096),height=optionInteger(config.height,'height',4096),quality=optionInteger(config.quality,'quality',100),maxFps=optionInteger(config.maxFps,'maxFps',30);
 if(config.requireExactResolution!==undefined&&typeof config.requireExactResolution!=="boolean")throw new TypeError('camera observation requireExactResolution must be boolean');
 const reconnect=config.reconnect??true,reconnectDelayMs=Math.max(0,Math.min(5_000,Math.trunc(config.reconnectDelayMs??100)));
 let lastFrameId:string|undefined,lastCapturedAtMs=-Infinity;
 while(!config.signal?.aborted){
  const controller=new AbortController();const abort=()=>controller.abort(config.signal?.reason);config.signal?.addEventListener('abort',abort,{once:true});
  try{
   const url=new URL(`${endpoint}/v1/droids/cameras/live`);url.searchParams.set('ref',ref);url.searchParams.set('camera',config.camera);
   if(width!==undefined)url.searchParams.set('width',String(width));if(height!==undefined)url.searchParams.set('height',String(height));if(quality!==undefined)url.searchParams.set('quality',String(quality));if(maxFps!==undefined)url.searchParams.set('max_fps',String(maxFps));if(config.requireExactResolution)url.searchParams.set('require_exact_resolution','true');
   const response=await fetchImpl(url.toString(),{method:'GET',headers:{authorization:`Bearer ${apiKey}`,accept:'application/x-ndjson'},signal:controller.signal});
   if(!response.ok)throw Error(`Vitrus live camera request failed (${response.status}): ${response.statusText}`);
   if(!response.body)throw Error('Vitrus live camera stream has no response body');
   const reader=response.body.getReader(),decoder=new TextDecoder();let buffered='';let serverRequestedReconnect=false;
   while(true){
    const next=await reader.read();buffered+=decoder.decode(next.value,{stream:!next.done});
    if(buffered.length>MAX_NDJSON_BUFFER_BYTES)throw Error('live camera stream exceeded the bounded NDJSON line size');
    const lines=buffered.split('\n');buffered=lines.pop()??'';
    for(const line of lines){
     if(!line.trim())continue;let event:unknown;try{event=JSON.parse(line);}catch{throw Error('live camera stream emitted malformed NDJSON');}
     if(event&&typeof event==='object'&&(event as Record<string,unknown>).type==='reconnect'){serverRequestedReconnect=true;continue;}
     if(event&&typeof event==='object'&&(event as Record<string,unknown>).type==='error')throw serverError(event as Record<string,unknown>);
     const frame=parseFrame(event);if(!frame)continue;
     const capturedAtMs=Date.parse(frame.capturedAt);
     // The public stream already rejects replay; retain this client-side check
     // so a reconnect cannot make stale media look like a new observation.
     if(frame.frameId===lastFrameId||capturedAtMs<=lastCapturedAtMs)continue;
     lastFrameId=frame.frameId;lastCapturedAtMs=capturedAtMs;yield frame;
    }
    if(next.done)break;
   }
   if(buffered.trim())throw Error('live camera stream ended with incomplete NDJSON');
   if(!reconnect&&!serverRequestedReconnect)return;
  }finally{config.signal?.removeEventListener('abort',abort);controller.abort();}
  if(!reconnect||config.signal?.aborted)return;
  await pause(reconnectDelayMs,config.signal);
 }
}
