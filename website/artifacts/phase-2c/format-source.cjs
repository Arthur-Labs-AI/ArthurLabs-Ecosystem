const fs=require('fs'),path=require('path'),ts=require('typescript'),postcss=require('postcss');
for(const name of fs.readdirSync('src/components/suite-launch')){
 const p=path.join('src/components/suite-launch',name);if(!/\.tsx?$/.test(name))continue;
 const source=ts.createSourceFile(p,fs.readFileSync(p,'utf8'),ts.ScriptTarget.Latest,true,name.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
 fs.writeFileSync(p,ts.createPrinter({newLine:ts.NewLineKind.LineFeed}).printFile(source));
}
const p='src/components/suite-launch/launch.module.css';const root=postcss.parse(fs.readFileSync(p,'utf8'));
function format(node,depth=0){if(!node.nodes)return;node.nodes.forEach((n,i)=>{n.raws.before=(i===0&&depth===0?'':'\n')+'  '.repeat(depth);if(n.type==='decl'){n.raws.between=': ';}else{n.raws.between=' ';format(n,depth+1);if(n.nodes)n.raws.after='\n'+'  '.repeat(depth);}});node.raws.semicolon=true;}
format(root);fs.writeFileSync(p,root.toString()+'\n');
