# Copper centerline graph statistics; pads/via transitions are zero-length connectors.
import pcbnew as p,pathlib,json,math,heapq,collections
p.SwigPyIterator.next=p.SwigPyIterator.__next__
D=pathlib.Path(__file__).resolve().parent
b=p.LoadBoard(str(D/'ARTHUR_EMG_RevA_Cost_Phase3B_FinalClean.kicad_pcb'));a=p.LoadBoard(str(D/'ARTHUR_EMG_RevA_Cost_Phase3A_ThreeNetClean.kicad_pcb'))
def uid(o):return o.m_Uuid.AsString()
def xy(q):return (p.ToMM(q.x),p.ToMM(q.y))
def v(q):return p.VECTOR2I(p.FromMM(q[0]),p.FromMM(q[1]))
old={uid(t) for t in a.GetTracks()};ts=[t for t in b.GetTracks() if t.GetNetname()=='AFE_3V0' and not isinstance(t,p.PCB_VIA)];vs=[t for t in b.GetTracks() if t.GetNetname()=='AFE_3V0' and isinstance(t,p.PCB_VIA)];pads={f.GetReference()+'.'+q.GetNumber():q for f in b.GetFootprints() for q in f.Pads() if q.GetNetname()=='AFE_3V0'}
points={uid(t):{xy(t.GetStart()),xy(t.GetEnd())} for t in ts};links=[]
def proj(q,t):
 s,e=xy(t.GetStart()),xy(t.GetEnd());dx=e[0]-s[0];dy=e[1]-s[1];k=max(0,min(1,((q[0]-s[0])*dx+(q[1]-s[1])*dy)/(dx*dx+dy*dy)));return (round(s[0]+k*dx,6),round(s[1]+k*dy,6))
def node(t,q):return (str(t.GetLayer()),round(q[0],6),round(q[1],6))
for i,t in enumerate(ts):
 for u in ts[i+1:]:
  if t.GetLayer()!=u.GetLayer() or not p.SHAPE.Collide(t.GetEffectiveShape(t.GetLayer()),u.GetEffectiveShape(u.GetLayer()),0):continue
  s,e=xy(t.GetStart()),xy(t.GetEnd());q,z=xy(u.GetStart()),xy(u.GetEnd());dx=e[0]-s[0];dy=e[1]-s[1];ex=z[0]-q[0];ey=z[1]-q[1];den=dx*ey-dy*ex
  if abs(den)>1e-12:
   k=((q[0]-s[0])*ey-(q[1]-s[1])*ex)/den;h=((q[0]-s[0])*dy-(q[1]-s[1])*dx)/den
   if 0<=k<=1 and 0<=h<=1:
    pt=(round(s[0]+k*dx,6),round(s[1]+k*dy,6));points[uid(t)].add(pt);points[uid(u)].add(pt);continue
  candidates=[(s,proj(s,u)),(e,proj(e,u)),(proj(q,t),q),(proj(z,t),z)];x,y=min(candidates,key=lambda q:math.dist(*q));points[uid(t)].add(x);points[uid(u)].add(y);links.append((node(t,x),node(u,y)))
for via in vs:
 vn=('via',uid(via));q=xy(via.GetPosition())
 for t in ts:
  if p.SHAPE.Collide(via.GetEffectiveShape(t.GetLayer()),t.GetEffectiveShape(t.GetLayer()),0):
   x=proj(q,t);points[uid(t)].add(x);links.append((vn,node(t,x)))
for k,pad in pads.items():
 pn=('pad',k)
 for t in ts:
  l=t.GetLayer()
  if pad.GetLayerSet().Contains(l) and p.SHAPE.Collide(pad.GetEffectiveShape(l),t.GetEffectiveShape(l),0):
   x=proj(xy(pad.GetPosition()),t);points[uid(t)].add(x);links.append((pn,node(t,x)))
 for via in vs:
  if any(pad.GetLayerSet().Contains(l) and p.SHAPE.Collide(pad.GetEffectiveShape(l),via.GetEffectiveShape(l),0) for l in [p.F_Cu,p.B_Cu]):links.append((pn,('via',uid(via))))
graph=collections.defaultdict(list)
def edge(x,y,w,neww=0,tid=None):graph[x].append((y,w,neww,tid));graph[y].append((x,w,neww,tid))
for t in ts:
 q=sorted(points[uid(t)],key=lambda q:math.dist(xy(t.GetStart()),q))
 for x,y in zip(q,q[1:]):
  w=math.dist(x,y);edge(node(t,x),node(t,y),w,w if uid(t) not in old else 0,uid(t))
for x,y in links:edge(x,y,0)
source=('pad','U4002.5');dist={source:0};prev={};queue=[(0,source)]
while queue:
 d,x=heapq.heappop(queue)
 if d!=dist[x]:continue
 for y,w,neww,tid in graph[x]:
  if d+w<dist.get(y,math.inf)-1e-12:dist[y]=d+w;prev[y]=(x,w,neww,tid);heapq.heappush(queue,(d+w,y))
required=['U501.4','U502.4','U503.4','C501.2','C503.2','D101.2','D102.2','D201.2','D202.2','D301.2','D302.2','D401.2','D402.2','R5003.2','U6001.1','C6007.1'];routes={}
for k in required:
 x=('pad',k);assert x in dist,k;pieces=[];newtotal=0
 while x!=source:
  y,w,n,tid=prev[x];newtotal+=n
  if tid:pieces.append({'uuid':tid,'portion_length_mm':w,'phase3b_added_portion_length_mm':n})
  x=y
 routes[k]={'source':'U4002.5','endpoint':k,'projected_centerline_length_mm':dist[('pad',k)],'phase3b_added_portion_length_mm':newtotal,'pieces':list(reversed(pieces))}
longest=max(routes.values(),key=lambda r:r['projected_centerline_length_mm']);longnew=max(routes.values(),key=lambda r:r['phase3b_added_portion_length_mm'])
r={'method':'Shortest source-to-required-endpoint paths on the final AFE_3V0 track centerline graph; same-net geometric contacts, pads and via transitions treated as zero-length connectors. Copper inside pads is not charged twice; vertical via barrel length and finite pad copper length are excluded. These are defined geometric path statistics, not resistance, delay or exhaustive longest-simple-path claims.','routes':routes,'longest_source_to_required_endpoint_route':longest,'largest_phase3b_added_length_on_source_route':longnew}
(D/'phase3b_final_route_metrics.json').write_text(json.dumps(r,indent=2)+'\n');print('Longest source route',longest['endpoint'],longest['projected_centerline_length_mm'],'new length',longest['phase3b_added_portion_length_mm']);print('Largest added source route',longnew['endpoint'],longnew['phase3b_added_portion_length_mm'])
