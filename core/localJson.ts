export const LOCAL_JSON_MAX_BYTES=2_000_000;
/** Matches UTF-8 storage bytes without depending on TextEncoder in native JS. */
export function localTextBytes(text:string):number {
 let bytes=0;
 for(let i=0;i<text.length;i++){
  const code=text.charCodeAt(i);
  if(code<0x80)bytes++;else if(code<0x800)bytes+=2;
  else if(code>=0xd800&&code<=0xdbff&&i+1<text.length&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff){bytes+=4;i++;}
  else bytes+=3;
 }
 return bytes;
}
export function validateLocalJsonFiles(files:Array<{name:string;text:string}>):void {
 if(!Array.isArray(files)||files.length<1||files.length>3)throw new Error('Choose one to three local JSON files.');
 let size=0;for(const file of files){if(!file||typeof file.text!=='string')throw new Error('Invalid local JSON file.');size+=localTextBytes(file.text);if(size>LOCAL_JSON_MAX_BYTES)throw new Error('Local JSON is limited to 2 MB (2,000,000 UTF-8 bytes) in total.');}
}
/** Compact serialization keeps a valid dense input from growing during export.
 * The same byte gate runs before either a browser download or native picker. */
export function serializeLocalJson(value:unknown):string {
 const text=JSON.stringify(value);if(text===undefined)throw new Error('Expected a JSON value.');validateLocalJsonFiles([{name:'export.json',text}]);return text;
}
