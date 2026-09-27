/**
 * TraceGrid local graph API server.
 *
 * Routes:
 *   GET /              → interactive graph canvas (SVG force layout)
 *   GET /graph         → { nodes, edges }
 *   GET /graph/nodes   → { nodes }
 *   GET /graph/edges   → { edges }
 *   GET /health        → { status: "ok" }
 */

import express, { Request, Response } from "express";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parseToGraph } from "@tracegrid/core";

export interface ServerOptions {
  port: number;
  archPath: string;
}

// ---------------------------------------------------------------------------
// Embedded interactive graph UI
// ---------------------------------------------------------------------------

const GRAPH_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>TraceGrid — Application Flow</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--surface:#161b22;--surface2:#21262d;--border:#30363d;
  --text:#e6edf3;--muted:#8b949e;
  --db:#3fb950;--api:#58a6ff;--fe:#bc8cff;
  --get:#3fb950;--post:#58a6ff;--put:#f0883e;--patch:#bc8cff;--delete:#ff7b72;
}
html,body{width:100%;height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:-apple-system,"Segoe UI",system-ui,sans-serif}

/* ── Header ── */
header{position:fixed;top:0;left:0;right:0;z-index:100;height:52px;background:rgba(13,17,23,0.96);backdrop-filter:blur(10px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 20px;gap:16px}
.logo{font-weight:700;font-size:15px;display:flex;align-items:center;gap:8px;white-space:nowrap}
.logo-icon{width:26px;height:26px;border-radius:5px;background:linear-gradient(135deg,var(--db),var(--api),var(--fe));display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:#0d1117;flex-shrink:0}
.header-stats{display:flex;gap:16px;font-size:12px;color:var(--muted)}
.stat-pill{display:flex;align-items:center;gap:5px;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot-db{background:var(--db)}.dot-api{background:var(--api)}.dot-fe{background:var(--fe)}
.stat-n{font-weight:700;color:var(--text)}
.header-right{display:flex;align-items:center;gap:10px}
#status-badge{font-size:11px;padding:3px 10px;border-radius:10px;font-weight:600;white-space:nowrap}
.badge-loading{background:rgba(88,166,255,.15);color:var(--api)}
.badge-ok{background:rgba(63,185,80,.15);color:var(--db)}
.badge-err{background:rgba(255,123,114,.15);color:#ff7b72}
.ctrl-btn{background:var(--surface2);border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;line-height:1.4}
.ctrl-btn:hover{color:var(--text);border-color:var(--muted)}

/* ── Canvas ── */
#canvas{position:fixed;top:52px;left:0;right:0;bottom:0;cursor:grab}
#canvas:active{cursor:grabbing}
#canvas.panning{cursor:grabbing}
svg{width:100%;height:100%}

/* ── Legend ── */
#legend{position:fixed;bottom:20px;left:20px;background:rgba(22,27,34,.92);border:1px solid var(--border);border-radius:8px;padding:12px 16px;font-size:12px;line-height:1.8;pointer-events:none;z-index:50}
.legend-row{display:flex;align-items:center;gap:8px;color:var(--muted)}
.legend-node{width:14px;height:14px;border-radius:3px;flex-shrink:0}
.legend-edge{width:24px;height:2px;flex-shrink:0;border-radius:1px}
.legend-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);margin-bottom:4px}

/* ── Tooltip ── */
#tooltip{position:fixed;pointer-events:none;z-index:200;background:rgba(22,27,34,.97);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:12px;line-height:1.7;max-width:280px;display:none;box-shadow:0 4px 16px rgba(0,0,0,.5)}
#tooltip .tt-title{font-weight:700;font-size:13px;margin-bottom:4px}
#tooltip .tt-row{color:var(--muted)}.tt-val{color:var(--text)}
.method-tag{display:inline-block;font-size:10px;font-weight:700;border-radius:3px;padding:1px 5px;margin-right:4px}
.m-GET{background:rgba(63,185,80,.2);color:var(--get)}
.m-POST{background:rgba(88,166,255,.2);color:var(--post)}
.m-PUT{background:rgba(240,136,62,.2);color:var(--put)}
.m-PATCH{background:rgba(188,140,255,.2);color:var(--patch)}
.m-DELETE{background:rgba(255,123,114,.2);color:var(--delete)}

/* ── Error banner ── */
#error-banner{position:fixed;top:72px;left:50%;transform:translateX(-50%);background:rgba(255,123,114,.1);border:1px solid rgba(255,123,114,.3);border-radius:8px;padding:12px 20px;color:#ff7b72;font-size:13px;display:none;z-index:300;max-width:500px;text-align:center}

/* ── SVG node/edge styles ── */
.node-circle{stroke-width:2;transition:r .15s,opacity .15s}
.node-circle.db{fill:#1a2c1d;stroke:var(--db)}
.node-circle.api{fill:#182230;stroke:var(--api)}
.node-circle.fe{fill:#1e1a2e;stroke:var(--fe)}
.node-circle:hover,.node-circle.highlighted{stroke-width:3;filter:brightness(1.3)}
.node-label-text{font-size:11px;fill:var(--text);pointer-events:none;text-anchor:middle;dominant-baseline:middle;font-family:-apple-system,"Segoe UI",system-ui,sans-serif;font-weight:600}
.node-label-bg{fill:rgba(13,17,23,.75);rx:3;ry:3}
.edge-line{stroke-width:1.5;fill:none;marker-end:url(#arrow-calls);opacity:.7}
.edge-line.calls{stroke:var(--fe);stroke-dasharray:none}
.edge-line.foreign-key{stroke:var(--db);marker-end:url(#arrow-fk)}
.edge-line.reads{stroke:var(--api);stroke-dasharray:4,3;marker-end:url(#arrow-rw)}
.edge-line.writes{stroke:var(--api);stroke-dasharray:none;marker-end:url(#arrow-rw)}
.edge-line.highlighted{opacity:1;stroke-width:2.5}
.edge-line.dimmed{opacity:.1}
.node-group.dimmed .node-circle{opacity:.2}
.node-group.dimmed .node-label-text{opacity:.2}
</style>
</head>
<body>

<header>
  <div class="logo">
    <div class="logo-icon">TG</div>
    TraceGrid &nbsp;<span style="color:var(--muted);font-weight:400;font-size:13px">Application Flow</span>
  </div>
  <div class="header-stats" id="header-stats"></div>
  <div class="header-right">
    <button class="ctrl-btn" id="btn-reset">⟳ Reset view</button>
    <button class="ctrl-btn" id="btn-freeze">❄ Freeze</button>
    <div id="status-badge" class="badge-loading">Loading…</div>
  </div>
</header>

<div id="canvas">
  <svg id="svg">
    <defs>
      <marker id="arrow-calls" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill="#bc8cff" opacity=".8"/>
      </marker>
      <marker id="arrow-fk" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill="#3fb950" opacity=".8"/>
      </marker>
      <marker id="arrow-rw" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill="#58a6ff" opacity=".8"/>
      </marker>
    </defs>
    <g id="zoom-group">
      <g id="edges-layer"></g>
      <g id="nodes-layer"></g>
    </g>
  </svg>
</div>

<div id="legend">
  <div class="legend-title">Node Tiers</div>
  <div class="legend-row"><div class="legend-node" style="background:#1a2c1d;border:2px solid #3fb950"></div><span>Database (DB)</span></div>
  <div class="legend-row"><div class="legend-node" style="background:#182230;border:2px solid #58a6ff"></div><span>API / Middleware</span></div>
  <div class="legend-row"><div class="legend-node" style="background:#1e1a2e;border:2px solid #bc8cff"></div><span>Frontend</span></div>
  <div class="legend-title" style="margin-top:8px">Edges</div>
  <div class="legend-row"><div class="legend-edge" style="background:#bc8cff"></div><span>calls (FE → API)</span></div>
  <div class="legend-row"><div class="legend-edge" style="background:#3fb950"></div><span>foreign-key (DB → DB)</span></div>
  <div class="legend-row"><div class="legend-edge" style="background:#58a6ff;background:repeating-linear-gradient(90deg,#58a6ff 0,#58a6ff 4px,transparent 4px,transparent 7px)"></div><span>reads / writes (API → DB)</span></div>
</div>

<div id="tooltip"></div>
<div id="error-banner" id="error-banner"></div>

<script>
(function(){
'use strict';

// ── constants ──
var W, H;
var TIER_X_RATIO = { database: 0.15, api: 0.5, frontend: 0.85 };
var TIER_COLOR   = { database: '#3fb950', api: '#58a6ff', frontend: '#bc8cff' };
var TIER_CLASS   = { database: 'db', api: 'api', frontend: 'fe' };
var METHOD_COLOR = { GET:'#3fb950', POST:'#58a6ff', PUT:'#f0883e', PATCH:'#bc8cff', DELETE:'#ff7b72' };
var NODE_R_BASE = 22;

// ── state ──
var nodes = [], edges = [], sim, frozen = false;
var transform = { x: 0, y: 0, k: 1 };
var drag = null, pan = null;

// ── SVG helpers ──
function svgEl(tag, attrs){
  var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for(var k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

// ── dedup nodes by id (keep first occurrence) ──
function dedupNodes(raw){
  var seen = {}, out = [];
  raw.forEach(function(n){ if(!seen[n.id]){ seen[n.id]=true; out.push(n); } });
  return out;
}
function dedupEdges(raw){
  var seen = {}, out = [];
  raw.forEach(function(e){ if(!seen[e.id]){ seen[e.id]=true; out.push(e); } });
  return out;
}

// ── assign initial positions in tier columns ──
function assignPositions(nodes){
  var byTier = { database:[], api:[], frontend:[] };
  nodes.forEach(function(n){ (byTier[n.tier]||byTier.api).push(n); });
  ['database','api','frontend'].forEach(function(tier){
    var list = byTier[tier];
    var cx = W * TIER_X_RATIO[tier];
    list.forEach(function(n, i){
      var spacing = Math.min(60, (H - 100) / Math.max(list.length, 1));
      n.x = cx + (Math.random()-0.5)*40;
      n.y = 100 + i * spacing + (Math.random()-0.5)*10;
      n.vx = 0; n.vy = 0;
    });
  });
}

// ── mini force simulation (no d3) ──
var TICK_INTERVAL = null;
function runSimulation(){
  if(TICK_INTERVAL) clearInterval(TICK_INTERVAL);
  var alpha = 1;
  TICK_INTERVAL = setInterval(function(){
    if(frozen){ return; }
    if(alpha < 0.005){ clearInterval(TICK_INTERVAL); return; }
    tick(alpha);
    alpha *= 0.97;
    renderPositions();
  }, 16);
}

function tick(alpha){
  var edgeMap = {};
  edges.forEach(function(e){
    if(!edgeMap[e.source]) edgeMap[e.source]=[];
    if(!edgeMap[e.target]) edgeMap[e.target]=[];
    edgeMap[e.source].push(e.target);
    edgeMap[e.target].push(e.source);
  });

  // Repulsion between all nodes
  for(var i=0;i<nodes.length;i++){
    var a = nodes[i];
    if(a.pinned) continue;
    for(var j=i+1;j<nodes.length;j++){
      var b = nodes[j];
      var dx = a.x-b.x, dy = a.y-b.y;
      var dist = Math.sqrt(dx*dx+dy*dy)||1;
      var force = alpha * 1800 / (dist*dist);
      var fx = dx/dist*force, fy = dy/dist*force;
      a.vx+=fx; a.vy+=fy;
      if(!b.pinned){ b.vx-=fx; b.vy-=fy; }
    }
  }

  // Attraction along edges
  edges.forEach(function(e){
    var s = nodeById(e.source), t = nodeById(e.target);
    if(!s||!t) return;
    var dx=t.x-s.x, dy=t.y-s.y;
    var dist=Math.sqrt(dx*dx+dy*dy)||1;
    var target=160, strength=alpha*0.08*(dist-target)/dist;
    var fx=dx*strength, fy=dy*strength;
    if(!s.pinned){s.vx+=fx;s.vy+=fy;}
    if(!t.pinned){t.vx-=fx;t.vy-=fy;}
  });

  // Tier gravity — pull each node toward its column x
  nodes.forEach(function(n){
    if(n.pinned) return;
    var cx = W * TIER_X_RATIO[n.tier||'api'];
    n.vx += (cx - n.x) * alpha * 0.12;
    // vertical centering
    n.vy += (H/2 - n.y) * alpha * 0.02;
  });

  // Vertical separation within tier
  var byTier = {};
  nodes.forEach(function(n){ if(!byTier[n.tier]) byTier[n.tier]=[]; byTier[n.tier].push(n); });
  Object.values(byTier).forEach(function(list){
    list.sort(function(a,b){return a.y-b.y;});
    for(var i=1;i<list.length;i++){
      var gap = list[i].y - list[i-1].y;
      var minGap = 55;
      if(gap < minGap){
        var push = (minGap-gap)*0.4*alpha;
        if(!list[i].pinned)   list[i].vy   += push;
        if(!list[i-1].pinned) list[i-1].vy -= push;
      }
    }
  });

  // Integrate + dampen + bounds
  nodes.forEach(function(n){
    if(n.pinned) return;
    n.vx*=0.6; n.vy*=0.6;
    n.x+=n.vx; n.y+=n.vy;
    var r = NODE_R_BASE;
    n.x = Math.max(r+10, Math.min(W-r-10, n.x));
    n.y = Math.max(r+10, Math.min(H-r-10, n.y));
  });
}

var nodeMap = {};
function nodeById(id){ return nodeMap[id]; }

// ── rendering ──
var edgeEls = {}, nodeEls = {};
function buildDOM(){
  var edgesLayer = document.getElementById('edges-layer');
  var nodesLayer = document.getElementById('nodes-layer');
  edgesLayer.innerHTML = ''; nodesLayer.innerHTML = '';
  edgeEls = {}; nodeEls = {};

  // Edges
  edges.forEach(function(e){
    var line = svgEl('path', {class:'edge-line '+e.type, id:'edge-'+e.id});
    edgesLayer.appendChild(line);
    edgeEls[e.id] = line;
  });

  // Nodes
  nodes.forEach(function(n){
    var g = svgEl('g', {class:'node-group', id:'ng-'+n.id, cursor:'pointer'});

    var r = NODE_R_BASE;
    var circle = svgEl('circle', {
      class: 'node-circle '+(TIER_CLASS[n.tier]||'api'),
      r: r, cx:0, cy:0
    });

    // Label — shorten if long
    var rawLabel = n.label.length>18 ? n.label.slice(0,17)+'…' : n.label;
    // For endpoints, show just path part
    if(n.kind==='endpoint'){
      var parts = n.label.split(' ');
      rawLabel = parts[1]||n.label;
      rawLabel = rawLabel.length>16 ? rawLabel.slice(0,15)+'…' : rawLabel;
    }

    var methodDot = null;
    if(n.kind==='endpoint' && n.meta && n.meta.method){
      methodDot = svgEl('circle', {
        r:5, cx: r-4, cy: -(r-4),
        fill: METHOD_COLOR[n.meta.method]||'#8b949e',
        stroke:'#0d1117','stroke-width':1.5
      });
    }

    var textBg = svgEl('rect', {class:'node-label-bg', x:-(rawLabel.length*3.2), y:r+2, width:(rawLabel.length*6.4), height:15, rx:3});
    var text = svgEl('text', {class:'node-label-text', y: r+11, 'font-size':'10'});
    text.textContent = rawLabel;

    g.appendChild(circle);
    if(methodDot) g.appendChild(methodDot);
    g.appendChild(textBg);
    g.appendChild(text);
    nodesLayer.appendChild(g);
    nodeEls[n.id] = { g, circle };

    // Hover interactions
    g.addEventListener('mouseenter', function(ev){ onNodeHover(n, ev); });
    g.addEventListener('mousemove',  function(ev){ moveTooltip(ev); });
    g.addEventListener('mouseleave', function(){   onNodeLeave(); });

    // Drag
    g.addEventListener('mousedown', function(ev){
      ev.stopPropagation();
      if(ev.button!==0) return;
      var sx = (ev.clientX - transform.x)/transform.k;
      var sy = (ev.clientY - 52 - transform.y)/transform.k;
      drag = { node:n, ox:sx-n.x, oy:sy-n.y };
      n.pinned = true;
    });
  });
}

function renderPositions(){
  edges.forEach(function(e){
    var el = edgeEls[e.id]; if(!el) return;
    var s = nodeById(e.source), t = nodeById(e.target);
    if(!s||!t) return;
    var dx=t.x-s.x, dy=t.y-s.y, dist=Math.sqrt(dx*dx+dy*dy)||1;
    // Shorten line to not overlap circles
    var r=NODE_R_BASE+3;
    var sx2=s.x+dx/dist*r, sy2=s.y+dy/dist*r;
    var tx2=t.x-dx/dist*(r+6), ty2=t.y-dy/dist*(r+6);
    // Slight curve if same tier
    if(s.tier===t.tier){
      var mx=(sx2+tx2)/2, my=(sy2+ty2)/2;
      var norm = dist>0 ? [-dy/dist*40, dx/dist*40] : [0,0];
      el.setAttribute('d','M'+sx2+','+sy2+' Q'+(mx+norm[0])+','+(my+norm[1])+' '+tx2+','+ty2);
    } else {
      el.setAttribute('d','M'+sx2+','+sy2+' L'+tx2+','+ty2);
    }
  });

  nodes.forEach(function(n){
    var el = nodeEls[n.id]; if(!el) return;
    el.g.setAttribute('transform','translate('+n.x+','+n.y+')');
  });
}

// ── tooltip ──
var tooltip = document.getElementById('tooltip');
function onNodeHover(n, ev){
  var m = n.meta||{};
  var lines = '<div class="tt-title">';
  if(n.kind==='endpoint' && m.method){
    lines += '<span class="method-tag m-'+m.method+'">'+m.method+'</span>';
  }
  lines += escH(n.label)+'</div>';

  if(n.kind==='endpoint'){
    if(m.handler) lines+='<div class="tt-row">Handler: <span class="tt-val">'+escH(m.handler)+'</span></div>';
    if(m.description) lines+='<div class="tt-row">'+escH(m.description)+'</div>';
  }
  if(n.kind==='table'){
    var cols = Array.isArray(m.columns)?m.columns:[];
    if(cols.length) lines+='<div class="tt-row">'+cols.slice(0,6).map(function(c){
      return escH(c.type)+' '+escH(c.name)+(c.primaryKey?' <b style=color:var(--db)>PK</b>':'')+(c.foreignKey?' <b style=color:var(--api)>FK</b>':'');
    }).join('<br>')+'</div>';
  }
  if(n.kind==='component'||n.kind==='file'){
    if(m.filePath) lines+='<div class="tt-row" style="word-break:break-all">'+escH(m.filePath)+'</div>';
  }
  // Count connections
  var connOut = edges.filter(function(e){return e.source===n.id;}).length;
  var connIn  = edges.filter(function(e){return e.target===n.id;}).length;
  if(connOut||connIn) lines+='<div class="tt-row" style="margin-top:4px;color:#8b949e">'+connOut+' outgoing · '+connIn+' incoming</div>';

  tooltip.innerHTML = lines;
  tooltip.style.display = 'block';
  moveTooltip(ev);

  // Highlight connected nodes
  highlightNode(n.id);
}

function moveTooltip(ev){
  var tx = ev.clientX+14, ty = ev.clientY+14;
  if(tx+300>window.innerWidth) tx = ev.clientX-300-6;
  if(ty+140>window.innerHeight) ty = ev.clientY-140-6;
  tooltip.style.left = tx+'px';
  tooltip.style.top  = ty+'px';
}

function onNodeLeave(){
  tooltip.style.display='none';
  clearHighlight();
}

function highlightNode(id){
  var connectedIds = new Set([id]);
  edges.forEach(function(e){
    if(e.source===id) connectedIds.add(e.target);
    if(e.target===id) connectedIds.add(e.source);
  });
  nodes.forEach(function(n){
    var el = nodeEls[n.id]; if(!el) return;
    if(connectedIds.has(n.id)){el.g.classList.remove('dimmed');}
    else{el.g.classList.add('dimmed');}
  });
  edges.forEach(function(e){
    var el = edgeEls[e.id]; if(!el) return;
    if(e.source===id||e.target===id){el.classList.add('highlighted');el.classList.remove('dimmed');}
    else{el.classList.add('dimmed');el.classList.remove('highlighted');}
  });
}
function clearHighlight(){
  nodes.forEach(function(n){ var el=nodeEls[n.id]; if(el) el.g.classList.remove('dimmed','highlighted'); });
  edges.forEach(function(e){ var el=edgeEls[e.id]; if(el) el.classList.remove('dimmed','highlighted'); });
}

// ── zoom / pan ──
function applyTransform(){
  document.getElementById('zoom-group').setAttribute('transform',
    'translate('+transform.x+','+transform.y+') scale('+transform.k+')');
}

var svg = document.getElementById('svg');
svg.addEventListener('wheel', function(ev){
  ev.preventDefault();
  var delta = ev.deltaY > 0 ? 0.9 : 1.1;
  var rect = svg.getBoundingClientRect();
  var mx = ev.clientX - rect.left;
  var my = ev.clientY - rect.top;
  transform.x = mx - (mx - transform.x)*delta;
  transform.y = my - (my - transform.y)*delta;
  transform.k = Math.max(0.2, Math.min(4, transform.k*delta));
  applyTransform();
}, {passive:false});

svg.addEventListener('mousedown', function(ev){
  if(ev.button!==0||drag) return;
  pan = {sx:ev.clientX, sy:ev.clientY, tx:transform.x, ty:transform.y};
});
window.addEventListener('mousemove', function(ev){
  if(drag){
    var sx=(ev.clientX-transform.x)/transform.k;
    var sy=(ev.clientY-52-transform.y)/transform.k;
    drag.node.x = sx-drag.ox;
    drag.node.y = sy-drag.oy;
    renderPositions();
    return;
  }
  if(pan){
    transform.x = pan.tx+(ev.clientX-pan.sx);
    transform.y = pan.ty+(ev.clientY-pan.sy);
    applyTransform();
  }
});
window.addEventListener('mouseup', function(){
  drag=null; pan=null;
});

// ── controls ──
document.getElementById('btn-reset').onclick = function(){
  transform={x:0,y:0,k:1}; applyTransform();
  nodes.forEach(function(n){n.pinned=false;});
  assignPositions(nodes);
  frozen=false;
  document.getElementById('btn-freeze').textContent='❄ Freeze';
  runSimulation();
};
document.getElementById('btn-freeze').onclick = function(){
  frozen=!frozen;
  this.textContent = frozen ? '▶ Resume' : '❄ Freeze';
  if(!frozen) runSimulation();
};

// ── resize ──
function resize(){
  W = window.innerWidth;
  H = window.innerHeight - 52;
  svg.setAttribute('viewBox','0 0 '+W+' '+H);
}
window.addEventListener('resize', function(){ resize(); });
resize();

// ── init ──
function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function init(graph){
  nodes = dedupNodes(graph.nodes||[]);
  edges = dedupEdges(graph.edges||[]);
  nodeMap = {};
  nodes.forEach(function(n){ nodeMap[n.id]=n; });

  // Header stats
  var dbN  = nodes.filter(function(n){return n.tier==='database';}).length;
  var apiN = nodes.filter(function(n){return n.tier==='api';}).length;
  var feN  = nodes.filter(function(n){return n.tier==='frontend';}).length;
  document.getElementById('header-stats').innerHTML =
    '<div class="stat-pill"><div class="dot dot-db"></div><span class="stat-n">'+dbN+'</span> DB</div>'+
    '<div class="stat-pill"><div class="dot dot-api"></div><span class="stat-n">'+apiN+'</span> API</div>'+
    '<div class="stat-pill"><div class="dot dot-fe"></div><span class="stat-n">'+feN+'</span> Frontend</div>'+
    '<div class="stat-pill" style="color:#8b949e"><span class="stat-n" style="color:#e6edf3">'+edges.length+'</span> edges</div>';

  var badge = document.getElementById('status-badge');
  badge.className='badge-ok';
  badge.textContent = nodes.length+' nodes · '+edges.length+' edges';

  assignPositions(nodes);
  buildDOM();
  renderPositions();
  runSimulation();
}

function showError(msg){
  var badge=document.getElementById('status-badge');
  badge.className='badge-err'; badge.textContent='Error';
  var eb=document.getElementById('error-banner');
  eb.textContent='⚠ '+msg; eb.style.display='block';
}

fetch('/graph')
  .then(function(r){
    if(!r.ok) return r.json().then(function(d){throw new Error(d.error||r.statusText);});
    return r.json();
  })
  .then(init)
  .catch(function(e){ showError(e.message||String(e)); });

})();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(options: ServerOptions): ReturnType<typeof express> {
  const app = express();

  const loadGraph = () => {
    const absPath = resolve(options.archPath);
    if (!existsSync(absPath)) {
      throw new Error(`architecture.md not found at: ${absPath}`);
    }
    const source = readFileSync(absPath, "utf-8");
    return parseToGraph(source);
  };

  // Interactive graph canvas UI
  app.get("/", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(GRAPH_UI_HTML);
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", archPath: options.archPath });
  });

  app.get("/graph", (_req: Request, res: Response) => {
    try {
      const graph = loadGraph();
      res.json(graph);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.get("/graph/nodes", (_req: Request, res: Response) => {
    try {
      const { nodes } = loadGraph();
      res.json({ nodes });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.get("/graph/edges", (_req: Request, res: Response) => {
    try {
      const { edges } = loadGraph();
      res.json({ edges });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return app;
}

export function startServer(options: ServerOptions): void {
  const app = createServer(options);
  app.listen(options.port, () => {
    console.log(`\n🟢 TraceGrid server running on http://localhost:${options.port}`);
    console.log(`   GET /             → interactive graph canvas`);
    console.log(`   GET /graph        → full { nodes, edges } JSON`);
    console.log(`   GET /graph/nodes  → nodes only`);
    console.log(`   GET /graph/edges  → edges only`);
    console.log(`   GET /health       → liveness check`);
    console.log(`\n   Reading: ${options.archPath}`);
    console.log("   Press Ctrl+C to stop.\n");
  });
}
