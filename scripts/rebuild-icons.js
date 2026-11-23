// Rebuild icons.json from the original Lucide SVGs. Each icon becomes [pathData, tags]; shapes become equivalent path commands.
const fs=require('fs');const path=require('path');
const dir='node_modules/lucide-static/icons';const old=require('../studio/icons.json');
const out={};let shapes=0;
const attr=(tag,name)=>{const m=new RegExp('\\s'+name+'="([^"]*)"').exec(tag);return m?m[1]:null};
const num=(v)=>+v||0;
for(const f of fs.readdirSync(dir).filter(x=>x.endsWith('.svg'))){
  const name=f.slice(0,-4);const svg=fs.readFileSync(path.join(dir,f),'utf8');
  const parts=[];
  for(const m of svg.matchAll(/<(path|circle|rect|line|polyline|polygon|ellipse)\b[^>]*?\/?>/g)){
    const t=m[0],k=m[1];
    if(k==='path'){const d=attr(t,'d');if(d)parts.push(d)}
    else if(k==='circle'){const cx=num(attr(t,'cx')),cy=num(attr(t,'cy')),r=num(attr(t,'r'));parts.push(`M${cx-r} ${cy}a${r} ${r} 0 1 0 ${2*r} 0a${r} ${r} 0 1 0 ${-2*r} 0`)}
    else if(k==='ellipse'){const cx=num(attr(t,'cx')),cy=num(attr(t,'cy')),rx=num(attr(t,'rx')),ry=num(attr(t,'ry'));parts.push(`M${cx-rx} ${cy}a${rx} ${ry} 0 1 0 ${2*rx} 0a${rx} ${ry} 0 1 0 ${-2*rx} 0`)}
    else if(k==='rect'){const x=num(attr(t,'x')),y=num(attr(t,'y')),w=num(attr(t,'width')),h=num(attr(t,'height')),rx=num(attr(t,'rx'));
      if(rx>0){parts.push(`M${x+rx} ${y}H${x+w-rx}a${rx} ${rx} 0 0 1 ${rx} ${rx}V${y+h-rx}a${rx} ${rx} 0 0 1 ${-rx} ${rx}H${x+rx}a${rx} ${rx} 0 0 1 ${-rx} ${-rx}V${y+rx}a${rx} ${rx} 0 0 1 ${rx} ${-rx}z`)}
      else parts.push(`M${x} ${y}H${x+w}V${y+h}H${x}z`)}
    else if(k==='line'){parts.push(`M${num(attr(t,'x1'))} ${num(attr(t,'y1'))}L${num(attr(t,'x2'))} ${num(attr(t,'y2'))}`)}
    else if(k==='polyline'||k==='polygon'){const pts=(attr(t,'points')||'').trim().split(/[\s,]+/).map(Number);let s='';for(let i=0;i<pts.length-1;i+=2)s+=(i?'L':'M')+pts[i]+' '+pts[i+1];if(k==='polygon')s+='z';parts.push(s)}
    shapes++;
  }
  const tags=old[name]?old[name][1]:'';
  if(parts.length)out[name]=[parts.join(' '),tags];
}
fs.writeFileSync('../studio/icons.json',JSON.stringify(out));
console.log('icons',Object.keys(out).length,'shapes',shapes);
console.log('clock',JSON.stringify(out.clock));
