import {expect,test} from 'bun:test';
import {CameraStreamError,observeCameraFrames} from './camera-live';
const bytes=new Uint8Array([255,216,255,217]);
const event=(id:string,at:string)=>JSON.stringify({type:'frame',camera:'head_camera',frameId:id,capturedAt:at,mimeType:'image/jpeg',dataBase64:Buffer.from(bytes).toString('base64'),receivedAtMs:123})+'\n';
const stream=(text:string)=>new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(text));controller.close();}});
const chunkedStream=(chunks:string[])=>new ReadableStream<Uint8Array>({start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close();}});

test('camera.observeFrames authenticates public GET and keeps only advancing source frames',async()=>{
 const requests:RequestInit[]=[];
 const fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{expect(new URL(String(input)).pathname).toBe('/v1/droids/cameras/live');expect(new URL(String(input)).searchParams.get('ref')).toBe('VTRS-R06');expect(new URL(String(input)).searchParams.get('camera')).toBe('head_camera');requests.push(init!);return new Response(stream(JSON.stringify({type:'ready'})+'\n'+event('one','2026-09-10T00:00:01Z')+event('one','2026-09-10T00:00:02Z')+event('two','2026-09-10T00:00:00Z')+event('three','2026-09-10T00:00:03Z')),{status:200});};
 const received=[];for await(const frame of observeCameraFrames({endpoint:'https://vitrus-dataplane.example',apiKey:'test-key',ref:'VTRS-R06',camera:'head_camera',fetch:fetch as typeof globalThis.fetch,reconnect:false}))received.push(frame);
 expect(received.map(frame=>frame.frameId)).toEqual(['one','three']);expect(received[0].bytes).toEqual(bytes);expect(new Headers(requests[0].headers).get('authorization')).toBe('Bearer test-key');
});

test('camera.observeFrames fails closed for malformed media and reconnects after expiry',async()=>{
 let calls=0;
 const fetch=async()=>{calls++;if(calls===1)return new Response(stream(JSON.stringify({type:'reconnect',reason:'reauth_required',streamFrameCount:0})+'\n'));return new Response(stream(event('fresh','2026-09-10T00:00:04Z')));};
 const iterator=observeCameraFrames({endpoint:'https://vitrus-dataplane.example',apiKey:'test-key',ref:'VTRS-R06',camera:'head_camera',fetch:fetch as typeof globalThis.fetch,reconnectDelayMs:0});
 const first=await iterator.next();await iterator.return?.();expect(first.value?.frameId).toBe('fresh');expect(calls).toBe(2);
 await expect((async()=>{for await(const _ of observeCameraFrames({endpoint:'https://vitrus-dataplane.example',apiKey:'test-key',ref:'VTRS-R06',camera:'head_camera',fetch:async()=>new Response(stream(JSON.stringify({type:'frame',camera:'head_camera',frameId:'bad',capturedAt:'bad',mimeType:'image/jpeg',dataBase64:'not base64',receivedAtMs:1})+'\n')) as typeof globalThis.fetch,reconnect:false})){} })()).rejects.toThrow('invalid capturedAt');
});

test('camera.observeFrames delivers a continuous 30 FPS public stream without a history queue',async()=>{
 const jpeg=new Uint8Array(24*1024).fill(7),dataBase64=Buffer.from(jpeg).toString('base64');
 const started=Date.parse('2026-09-10T00:00:00.000Z');
 const frames=Array.from({length:90},(_,index)=>JSON.stringify({type:'frame',camera:'head_camera',frameId:`f-${index}`,capturedAt:new Date(started+index*34).toISOString(),mimeType:'image/jpeg',dataBase64,receivedAtMs:started+index*34})+'\n');
 const received: string[]=[];
 for await(const frame of observeCameraFrames({endpoint:'https://vitrus-dataplane.example',apiKey:'test-key',ref:'VTRS-R06',camera:'head_camera',fetch:async()=>new Response(chunkedStream(frames)) as typeof globalThis.fetch,reconnect:false}))received.push(frame.frameId);
 expect(received).toHaveLength(90);
 expect(received[0]).toBe('f-0');expect(received.at(-1)).toBe('f-89');
});

test('camera.observeFrames bounds an unterminated public NDJSON record',async()=>{
 const oversized='x'.repeat(2_100_000);
 const iterator=observeCameraFrames({endpoint:'https://vitrus-dataplane.example',apiKey:'test-key',ref:'VTRS-R06',camera:'head_camera',fetch:async()=>new Response(stream(oversized)) as typeof globalThis.fetch,reconnect:false});
 await expect(iterator.next()).rejects.toThrow('bounded NDJSON line size');
});

test('camera.observeFrames propagates a definite Bridge rendition error without reconnecting',async()=>{
 for(const reconnect of [false,true]){
  let calls=0;
  const iterator=observeCameraFrames({endpoint:'https://vitrus-dataplane.example',apiKey:'test-key',ref:'VTRS-R06',camera:'head_camera',reconnect,reconnectDelayMs:0,fetch:(async()=>{
   // Exact deployed Bridge error shape: `statusCode`, snake-free profiles,
   // and a stable `error` code rather than a generic HTTP response body.
   calls++;return new Response(stream(JSON.stringify({type:'error',error:'rendition_unavailable',statusCode:503,message:'requested rendition is not available',camera:'head_camera',requestedProfile:{maxFps:30},actualDeliveryProfile:{width:640,height:360,quality:75,maxFps:10},actualSourceProfile:{width:1280,height:720,fps:29.97,fourcc:'MJPG'},sourceProfileEpoch:'profile-8'})+'\n'));
  }) as typeof globalThis.fetch});
  try{await expect(iterator.next()).rejects.toMatchObject({name:'CameraStreamError',code:'rendition_unavailable',status:503,camera:'head_camera',requestedProfile:{maxFps:30},actualDeliveryProfile:{width:640,height:360,quality:75,maxFps:10},actualSourceProfile:{width:1280,height:720,fps:29.97,fourcc:'MJPG'},sourceProfileEpoch:'profile-8'} satisfies Partial<CameraStreamError>);}
  finally{await iterator.return?.();}
  expect(calls).toBe(1);
 }
});
