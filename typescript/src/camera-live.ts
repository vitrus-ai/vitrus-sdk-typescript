/** Public, latest-only camera frames from the Vitrus dataplane. */
import type {CameraFrame,DroidRef} from './droid.js';

export type CameraObservationOptions={signal?:AbortSignal;reconnect?:boolean;reconnectDelayMs?:number;fetch?:typeof globalThis.fetch};
export type ObserveCameraFramesOptions={endpoint:string;apiKey:string;ref:DroidRef;camera:string}&CameraObservationOptions;
export type LiveCameraFrame=CameraFrame&{bytes:Uint8Array;receivedAtMs:number};
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
 return {camera,frameId,capturedAt,mimeType,dataBase64,bytes:decodeFrame(dataBase64),receivedAtMs,...(typeof frame.width==='number'?{width:frame.width}:{}),...(typeof frame.height==='number'?{height:frame.height}:{})};
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
 const reconnect=config.reconnect??true,reconnectDelayMs=Math.max(0,Math.min(5_000,Math.trunc(config.reconnectDelayMs??100)));
 let lastFrameId:string|undefined,lastCapturedAtMs=-Infinity;
 while(!config.signal?.aborted){
  const controller=new AbortController();const abort=()=>controller.abort(config.signal?.reason);config.signal?.addEventListener('abort',abort,{once:true});
  try{
   const url=new URL(`${endpoint}/v1/droids/cameras/live`);url.searchParams.set('ref',ref);url.searchParams.set('camera',config.camera);
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
