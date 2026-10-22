from pathlib import Path
from html import escape
p=Path('artifacts/concept-refinement')
BG='#0d1012';TEXT='#e9e7df';MUTED='#9da69e';LINE='#303a35';MINT='#bed2bd';PURPLE='#b59cfa';GREEN='#a4c995'
def text(x,y,s,size=14,color=TEXT,weight=400):return f'<text x="{x}" y="{y}" fill="{color}" font-size="{size}" font-weight="{weight}">{escape(s)}</text>'
def rect(x,y,w,h,fill='#141a17',stroke=LINE,rx=10):return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}"/>'
def line(x,y,xx,yy,color=LINE):return f'<path d="M{x} {y}L{xx} {yy}" fill="none" stroke="{color}"/>'
def svg(w,h,body):return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" style="font-family:Inter,Arial,sans-serif"><rect width="100%" height="100%" fill="{BG}"/>{body}</svg>'
def node(x,y,label,color=MINT,w=115):return rect(x,y,w,38,'#141918',color,4)+text(x+10,y+24,label,11,color)
# A visual treatment proposal, not an executable continuation of the film.
b=text(45,46,'FROM THOUGHT TO CREATION / FULL WORKFLOW STORYBOARD',19)+text(45,74,'Design proposal • current opening only is implemented • all project activity is illustrative',12,MUTED)
b+=text(45,110,'ARTHUR STUDIO  →  NEXUS  →  SENTRY  →  NEXUS  →  ARTHUR STUDIO',15,MINT)
titles=['01 / Capture','02 / Connected knowledge','03 / Structured requirements','04 / Nexus orchestration','05 / Sentry receives review scope','06 / Independent verification','07 / Findings return to Nexus','08 / Nexus consolidates','09 / Knowledge returns to Studio']
captions=['One idea, before work has a shape.','The same intention finds its constraints.','Relationships become a deliberate plan.','Context coordinates conceptual work.','Work and constraints cross a review boundary.','Questions become illustrative findings.','No direct Sentry-to-Studio handoff.','Keep summaries, findings and open work together.','Return to the original idea, with richer context.']
for i,(title,cap) in enumerate(zip(titles,captions)):
 x=35+(i%3)*465;y=150+(i//3)*325;c=MINT if i<3 or i==8 else GREEN if i in[4,5]else PURPLE
 b+=rect(x,y,440,300,'#111613',LINE)+text(x+20,y+30,title,16,c)+text(x+20,y+52,'CURRENT OPENING' if i<4 else 'PROPOSED / NOT IMPLEMENTED',8,MUTED)
 if i==0:
  b+=text(x+35,y+123,'An offline-first',27)+text(x+35,y+155,'task manager.',27)+line(x+35,y+196,x+399,y+196,MINT)
 elif i in[1,8]:
  labels=['Local data','Task lifecycle','Privacy']if i==1 else['Decisions','Findings','Remaining work']
  b+=node(x+145,y+105,'Original idea',c,140)
  for j,l in enumerate(labels):b+=line(x+215,y+143,x+45+j*130,y+185,c)+node(x+10+j*140,y+185,l,c,130)
 elif i==2:
  b+=node(x+20,y+126,'Project context',c,130)
  for j,l in enumerate(['Local persistence','Task lifecycle','Review scope']):b+=line(x+150,y+145,x+210,y+96+j*51,c)+node(x+210,y+77+j*51,l,c,190)
 elif i==3:
  b+=node(x+20,y+125,'Context',c,95)+line(x+115,y+145,x+145,y+145,c)+node(x+145,y+125,'Coordinate',c,115)
  for j,l in enumerate(['Storage','Interactions']):b+=line(x+260,y+144,x+299,y+98+j*92,c)+node(x+299,y+79+j*92,l,c,118)
 elif i==4:
  b+=node(x+20,y+131,'Nexus work',PURPLE,110)+line(x+130,y+150,x+190,y+150,c)+rect(x+190,y+83,225,140,'#141c16',c,4)
  for j,l in enumerate(['Implementation scope','Requirements & constraints','Open questions']):b+=text(x+209,y+115+j*34,l,12,c)
 elif i==5:
  for j,l in enumerate(['Quality: example title validation','Security: data boundary question','Coverage: unresolved sync policy']):b+=line(x+24,y+101+j*47,x+410,y+101+j*47,c)+text(x+25,y+124+j*47,l,12,c)
  b+=text(x+25,y+238,'ILLUSTRATIVE FINDINGS / NO PASS CLAIM',8,MUTED)
 elif i==6:
  b+=node(x+20,y+86,'Execution summary',PURPLE,180)+node(x+20,y+167,'Sentry findings',GREEN,180)
  b+=line(x+200,y+105,x+280,y+145,PURPLE)+line(x+200,y+186,x+280,y+145,GREEN)+node(x+280,y+126,'Nexus',PURPLE,120)
 elif i==7:
  for j,l in enumerate(['Execution + review context','Decisions remain attributable','Outstanding work stays open']):b+=rect(x+24,y+83+j*48,392,38,'#191623',LINE,4)+text(x+38,y+107+j*48,l,12,c)
 b+=text(x+20,y+278,cap,11,MUTED)
(p/'full-workflow-storyboard.svg').write_text(svg(1440,1145,b))
# Download-first review drawing. All fields deliberately show unverified data.
b=text(65,54,'ArthurLabs',22)+text(770,54,'Suite      Products      Hardware      About',12,MUTED)+line(0,83,1440,83)
b+=text(65,120,'LAYOUT PROPOSAL / NOT IMPLEMENTED',9,MUTED)
b+=text(65,190,'THE ARTHURLABS SUITE',10,MINT)+text(65,254,'Three independent tools.',46)+text(65,312,'One place to get started.',46)
b+=text(65,355,'Arthur Studio · Nexus · Sentry',18,MINT)+text(65,396,'Get the applications. Follow their own installation paths.',14,MUTED)
b+=text(65,423,'Explore how they connect when you are ready.',14,MUTED)
b+=rect(835,154,540,420,'#151a18',LINE)+text(864,193,'FULL SUITE',15)+text(864,225,'Release details unverified',12,MINT)
b+=text(864,264,'Operating system',10,MUTED)+rect(864,278,480,44,'#1b211e',LINE,5)+text(880,305,'Platforms unconfirmed',12,MUTED)
b+=text(864,348,'Architecture',10,MUTED)+rect(864,362,480,44,'#1b211e',LINE,5)+text(880,389,'Architectures unconfirmed',12,MUTED)
b+=rect(864,429,480,48,'#30362f',LINE,5)+text(888,459,'Full Suite download unavailable',15,'#a1aa9a')
b+=text(864,510,'No verified Suite installer is published on this page.',11,MUTED)+text(864,541,'Explore the individual applications ↓',12,TEXT)
b+=line(65,620,1375,620)+text(65,677,'01 / INCLUDED APPLICATIONS',10,MINT)+text(65,728,'Independent by design.',35)
for i,(name,role,color)in enumerate([('Arthur Studio','Capture & project knowledge',MINT),('Nexus','Coordination & execution',PURPLE),('Sentry','Independent verification',GREEN)]):
 x=65+i*444;b+=rect(x,768,420,315,'#141a17',LINE)+text(x+24,808,name,24,color)+text(x+24,840,role,12,MUTED)+rect(x+24,867,180,40,'#1b211e',LINE,4)+text(x+34,892,'Target unconfirmed',10,MUTED)+rect(x+216,867,180,40,'#1b211e',LINE,4)+text(x+226,892,'Arch unconfirmed',10,MUTED)+rect(x+24,927,372,44,'#30362f',LINE,4)+text(x+42,954,'Individual download unavailable',12,'#a1aa9a')+text(x+24,1004,'Release/platform details unverified',11,MUTED)+text(x+24,1045,'Product information ↗',12,color)
y=1150
for n,title,desc,h in [('02','Release & compatibility','Actual selected-target metadata only. No placeholder versions.',140),('03','Install the applications','Verified target-specific instructions. Independent applications.',175),('04','Documentation & source','Verified destinations only; unavailable links remain plain text.',140),('05','Explore the connected workflow','Optional, explicitly opened film: Studio → Nexus → Sentry → Nexus → Studio.',270),('06','Beyond software','Hardware research teaser. No released-device claims.',145)]:
 b+=line(65,y,1375,y)+text(65,y+45,n+' / '+title.upper(),10,MINT)+text(65,y+90,title,30)+text(65,y+122,desc,13,MUTED)
 if n=='05':b+=rect(65,y+150,1310,78,'#141819',LINE)+text(92,y+196,'Explore the workflow →   •   conceptual demonstration   •   read still storyboard',14,PURPLE)
 y+=h+38
b+=text(65,y+38,'GLOBAL FOOTER PRESERVED',10,MUTED)
(p/'download-layout-desktop.svg').write_text(svg(1440,y+100,b))
b=text(24,40,'ArthurLabs',18)+text(307,40,'Menu',12,MUTED)+line(0,65,390,65)+text(24,94,'PROPOSAL / NOT IMPLEMENTED',8,MUTED)
b+=text(24,145,'Three tools.',36)+text(24,187,'One place to start.',36)+text(24,222,'Arthur Studio · Nexus · Sentry',12,MINT)
b+=rect(24,250,342,334,'#151a18',LINE)+text(42,282,'FULL SUITE',13)+text(42,311,'Release details unverified',11,MINT)
for y,label in[(330,'Platforms unconfirmed'),(389,'Architectures unconfirmed')]:b+=rect(42,y,306,43,'#1b211e',LINE,4)+text(55,y+27,label,11,MUTED)
b+=rect(42,449,306,46,'#30362f',LINE,4)+text(56,478,'Full Suite download unavailable',12,'#a1aa9a')+text(42,524,'No verified installer is published here.',10,MUTED)+text(42,556,'Individual applications ↓',11,TEXT)
y=638
for i,(name,role,color)in enumerate([('Arthur Studio','Capture & knowledge',MINT),('Nexus','Coordination & execution',PURPLE),('Sentry','Independent verification',GREEN)]):
 b+=rect(24,y,342,205,'#141a17',LINE)+text(42,y+37,name,23,color)+text(42,y+65,role,12,MUTED)+text(42,y+88,'Release details unverified',10,MUTED)+rect(42,y+105,306,44,'#30362f',LINE,4)+text(56,y+132,'Individual download unavailable',11,'#a1aa9a')+text(42,y+184,'Product information ↗',11,color);y+=225
for title,desc,h in [('Release & compatibility','Verified metadata only',130),('Installation guidance','Target-specific, verified instructions',160),('Docs & source','Verified destinations only',130),('Optional workflow','Explicit entry • conceptual demonstration',200),('Hardware research','Explore the existing hardware page',140)]:
 b+=line(24,y,366,y)+text(24,y+47,title,25)+text(24,y+81,desc,11,MUTED)
 if title=='Optional workflow':b+=rect(24,y+108,342,55,'#171522',LINE,4)+text(42,y+141,'Explore the workflow →',12,PURPLE)
 y+=h
b+=text(24,y+35,'GLOBAL FOOTER PRESERVED',9,MUTED)
(p/'download-layout-mobile.svg').write_text(svg(390,y+90,b))
