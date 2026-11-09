// The network of all stations (like all.html) mapped onto a transparent sphere.
// The begriffe are pinned, evenly spread over the sphere surface. Two variants for the words:
//   a: every word lies on the surface, links are arcs along the surface
//   b: words with 1 link float outside the sphere, with 2 links on the surface,
//      with 3 or more links inside; links are straight lines
// Uses the data helpers and size constants of network.js; 3D layout and projection are here.

const R = 300; // sphere radius in world units
const OUTSIDE = [1.15, 1.4]; // variant b: words with 1 link stay in this shell outside the sphere (x R)
const INSIDE = 0.9; // variant b: words with 3+ links stay at least this far in (x R)
const DIST_3D = [0.1 * R, 0.7 * R]; // link rest length, from the smallest to the largest distanz
const REPULSION = 0.12 * R; // words closer than this push each other apart
const ITERATIONS = 300;
const CAMERA = 3 * R; // distance of the camera from the sphere center (perspective)

let rows = [];
let graph = null; // { nodes, links } with 3D positions in node.p
let rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1]; // 3x3 matrix, row major
let zoomK = 1;
let selected = null;

loadRows().then((csv) => {
  rows = csv;
  d3.select("#mode").on("change", layoutAndDraw);
  d3.select("#min-anzahl").on("change", layoutAndDraw);
  window.addEventListener("resize", render);
  zoomK = fitZoom();
  layoutAndDraw();
});

// ---------- 3D layout ----------

function layoutAndDraw() {
  const mode = d3.select("#mode").property("value");
  const { nodes, links, begriffe } = buildGraph(filterMinAnzahl(aggregateRows(rows)));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  links.forEach((l) => {
    l.source = byId.get(l.source);
    l.target = byId.get(l.target);
  });

  // begriffe on a Fibonacci spiral over the sphere: even spacing, neighbors in station order
  const golden = Math.PI * (3 - Math.sqrt(5));
  begriffe.forEach((b, i) => {
    const y = 1 - (2 * (i + 0.5)) / begriffe.length;
    const r = Math.sqrt(1 - y * y);
    b.p = [Math.cos(i * golden) * r * R, y * R, Math.sin(i * golden) * r * R];
    b.fixed = true;
  });

  nodes.forEach((n) => (n.degree = 0));
  links.forEach((l) => {
    l.source.degree++;
    l.target.degree++;
  });

  // words start in the direction of the begriffe they are linked to (weighted by anzahl)
  const random = d3.randomLcg(42);
  const words = nodes.filter((n) => !n.fixed);
  words.forEach((w) => {
    const dir = [0, 0, 0];
    links.forEach((l) => {
      const other = l.source === w ? l.target : l.target === w ? l.source : null;
      if (other && other.fixed) for (let k = 0; k < 3; k++) dir[k] += other.p[k] * l.anzahl;
    });
    for (let k = 0; k < 3; k++) dir[k] += (random() - 0.5) * 0.4 * R;
    w.p = scaleTo(dir, R);
    w.v = [0, 0, 0];
  });

  const restLength = d3
    .scalePow()
    .exponent(DIST_EXPONENT)
    .domain(extentOrUnit(links.map((d) => d.distanz)))
    .range(DIST_3D);

  for (let it = 0; it < ITERATIONS; it++) {
    const alpha = 1 - it / ITERATIONS;

    // springs: each link pulls/pushes its word towards its rest length
    links.forEach((l) => {
      const a = l.source;
      const b = l.target;
      if (a.fixed && b.fixed) return;
      const d = sub(b.p, a.p);
      const len = norm(d) || 1;
      const f = ((len - restLength(l.distanz)) / len) * 0.3 * alpha;
      const wa = a.fixed ? 0 : b.fixed ? 1 : 0.5;
      const wb = 1 - wa;
      for (let k = 0; k < 3; k++) {
        if (!a.fixed) a.v[k] += d[k] * f * wa * 2;
        if (!b.fixed) b.v[k] -= d[k] * f * wb * 2;
      }
    });

    // short-range repulsion between words, and from the begriffe
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        if (a.fixed && b.fixed) continue;
        const d = sub(a.p, b.p);
        const len = norm(d);
        if (len >= REPULSION || len === 0) continue;
        const f = ((REPULSION - len) / len) * 0.25 * alpha;
        for (let k = 0; k < 3; k++) {
          if (!a.fixed) a.v[k] += d[k] * f;
          if (!b.fixed) b.v[k] -= d[k] * f;
        }
      }
    }

    // move, damp, then apply the constraint of the variant
    words.forEach((w) => {
      for (let k = 0; k < 3; k++) {
        w.p[k] += w.v[k];
        w.v[k] *= 0.6;
      }
      const r = norm(w.p);
      if (mode === "a" || w.degree === 2) w.p = scaleTo(w.p, R);
      else if (w.degree === 1) w.p = scaleTo(w.p, Math.max(OUTSIDE[0] * R, Math.min(OUTSIDE[1] * R, r)));
      else if (w.degree >= 3 && r > INSIDE * R) w.p = scaleTo(w.p, INSIDE * R);
    });
  }

  // link geometry: links between two nodes on the surface are arcs along it (all links in
  // variant a; in variant b those between begriffe and words with 2 links), the rest straight
  const onSurface = (n) => mode === "a" || n.fixed || n.degree === 2;
  links.forEach((l) => {
    l.points =
      onSurface(l.source) && onSurface(l.target)
        ? arc(l.source.p, l.target.p)
        : [l.source.p, l.target.p];
  });

  graph = { nodes, links, begriffe };
  selected = null;
  draw();
}

// ---------- drawing ----------

let svg, gSphere, gLinks, gNodes, gLabels, gCounts;

function draw() {
  svg = d3.select("#network-svg");
  svg.selectAll("*").remove();

  // rotate by dragging, zoom with the wheel, click the background to clear the highlight
  svg.call(
    d3.drag().on("drag", (event) => {
      rotation = multiply(rotY(event.dx * 0.005), multiply(rotX(event.dy * 0.005), rotation));
      render();
    }),
  );
  svg.on("wheel", (event) => {
    event.preventDefault();
    zoomK = Math.max(0.2, Math.min(10, zoomK * Math.exp(-event.deltaY * 0.0015)));
    render();
  });
  svg.on("click", () => {
    selected = null;
    highlight();
  });

  gSphere = svg.append("g");
  gLinks = svg.append("g");
  gNodes = svg.append("g");
  gLabels = svg.append("g");
  gCounts = svg.append("g");

  // transparent sphere: outline plus a few meridians and parallels for orientation
  gSphere.append("circle").attr("class", "outline").attr("fill", "none").attr("stroke", cInk);
  gSphere
    .selectAll("path")
    .data(wireframe())
    .enter()
    .append("path")
    .attr("fill", "none")
    .attr("stroke", cInk)
    .attr("stroke-width", 0.5);

  const { nodes, links, begriffe } = graph;
  const radiusScale = d3
    .scaleSqrt()
    .domain(extentOrUnit(nodes.filter((n) => n.type === "wort").map((n) => n.total)))
    .range(R_WORD);
  const begriffScale = d3
    .scaleSqrt()
    .domain([0, d3.max(begriffe, (n) => n.vorkommen ?? n.total)])
    .range([0, R_BEGRIFF[1]]);
  nodes.forEach((n) => {
    n.r =
      n.type === "begriff"
        ? Math.max(R_BEGRIFF[0], begriffScale(n.vorkommen ?? n.total))
        : radiusScale(n.total);
  });

  gLinks
    .selectAll("path")
    .data(links)
    .enter()
    .append("path")
    .attr("fill", "none")
    .attr("stroke", cInk)
    .attr("stroke-width", 1);

  gNodes
    .selectAll("circle")
    .data(nodes)
    .enter()
    .append("circle")
    .attr("fill", (d) => (d.type === "begriff" ? "#ffffff" : cInk))
    .attr("stroke", cInk)
    .attr("stroke-width", (d) => (d.type === "begriff" ? STROKE_BEGRIFF : 0))
    .style("cursor", "pointer")
    .on("click", (event, d) => {
      event.stopPropagation();
      selected = selected === d ? null : d;
      highlight();
    })
    .append("title")
    .text((d) =>
      d.type === "begriff"
        ? `${d.label}: ${d.vorkommen ?? "?"} Vorkommen, ${d.total} Co-Occurrences`
        : `${d.label}: ${d.total}`,
    );

  gLabels
    .selectAll("text")
    .data(nodes)
    .enter()
    .append("text")
    .attr("dy", ".35em")
    .attr("fill", cInk)
    .attr("font-size", (d) => (d.type === "begriff" ? 14 : null))
    .attr("font-weight", (d) => (d.type === "begriff" ? "bold" : null));

  gCounts
    .selectAll("text")
    .data(begriffe)
    .enter()
    .append("text")
    .attr("text-anchor", "middle")
    .attr("dy", ".35em")
    .attr("font-weight", "bold")
    .attr("fill", cInk)
    .style("display", "none");

  highlight();
}

// projects every element with the current rotation and zoom
function render() {
  if (!graph) return;
  const width = window.innerWidth;
  const height = window.innerHeight;
  svg.attr("viewBox", [0, 0, width, height]);
  const project = (p) => {
    const q = apply(rotation, p);
    const s = (CAMERA / (CAMERA - q[2])) * zoomK; // perspective
    return [width / 2 + q[0] * s, height / 2 + q[1] * s, q[2], CAMERA / (CAMERA - q[2])];
  };
  // depth cue: things at the back of the sphere are lighter
  const depth = (z) => 0.2 + 0.8 * Math.max(0, Math.min(1, (z + 1.3 * R) / (2.6 * R)));
  const line = (points) => "M" + points.map((p) => project(p).slice(0, 2).join(",")).join("L");

  const silhouette = (zoomK * R * CAMERA) / Math.sqrt(CAMERA * CAMERA - R * R);
  gSphere
    .select(".outline")
    .attr("cx", width / 2)
    .attr("cy", height / 2)
    .attr("r", silhouette)
    .attr("stroke-opacity", 0.5);
  gSphere.selectAll("path").attr("d", line).attr("stroke-opacity", 0.08);

  graph.nodes.forEach((n) => (n.s = project(n.p)));
  const on = connectedTo(selected);
  const dim = (d, value) => (on && !on.has(d.id) ? value * 0.1 : value);

  gLinks
    .selectAll("path")
    .attr("d", (l) => line(l.points))
    .attr("stroke-opacity", (l) => {
      const z = (l.source.s[2] + l.target.s[2]) / 2;
      if (!selected) return 0.25 * depth(z);
      return l.source === selected || l.target === selected ? 0.9 * depth(z) : 0.02;
    });
  gNodes
    .selectAll("circle")
    .attr("cx", (d) => d.s[0])
    .attr("cy", (d) => d.s[1])
    .attr("r", (d) => d.r * d.s[3])
    .attr("opacity", (d) => dim(d, depth(d.s[2])));
  gLabels
    .selectAll("text")
    .attr("x", (d) => d.s[0] + d.r * d.s[3] + 4)
    .attr("y", (d) => d.s[1])
    .attr("opacity", (d) => dim(d, depth(d.s[2])));
  gCounts
    .selectAll("text")
    .attr("x", (d) => d.s[0])
    .attr("y", (d) => d.s[1])
    .attr("font-size", (d) => Math.min(12, d.r * d.s[3] * 0.9));
}

// ids of the selected node and its neighbors (null when nothing is selected)
function connectedTo(node) {
  if (!node) return null;
  const ids = new Set([node.id]);
  graph.links.forEach((l) => {
    if (l.source === node) ids.add(l.target.id);
    if (l.target === node) ids.add(l.source.id);
  });
  return ids;
}

// like the 2D pages: anzahl in the circle of a connected begriff, after the label of a connected word
function highlight() {
  const anzahl = new Map();
  if (selected) {
    graph.links.forEach((l) => {
      if (l.source !== selected && l.target !== selected) return;
      const other = l.source === selected ? l.target : l.source;
      anzahl.set(other.id, (anzahl.get(other.id) ?? 0) + l.anzahl);
    });
  }
  gCounts
    .selectAll("text")
    .style("display", (d) => (anzahl.has(d.id) ? null : "none"))
    .text((d) => anzahl.get(d.id));
  gLabels
    .selectAll("text")
    .text((d) =>
      d.type === "wort" && anzahl.has(d.id)
        ? `${d.label.toLowerCase()} · ${anzahl.get(d.id)}`
        : d.label.toLowerCase(),
    );
  render();
}

// zoom so the sphere plus the words outside it fit the window
function fitZoom() {
  return (Math.min(window.innerWidth, window.innerHeight) / 2 - 40) / (1.45 * R);
}

// ---------- geometry ----------

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function norm(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

function scaleTo(a, length) {
  const n = norm(a) || 1;
  return [(a[0] / n) * length, (a[1] / n) * length, (a[2] / n) * length];
}

// points along the great circle between a and b (both on the sphere), via slerp;
// about one segment per 1.5 degrees, so long arcs stay smooth
function arc(a, b) {
  const ua = scaleTo(a, 1);
  const ub = scaleTo(b, 1);
  const dot = Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-6) return [a, b];
  const segments = Math.max(4, Math.ceil(omega / ((1.5 * Math.PI) / 180)));
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const wa = Math.sin((1 - t) * omega) / Math.sin(omega);
    const wb = Math.sin(t * omega) / Math.sin(omega);
    points.push([0, 1, 2].map((k) => (ua[k] * wa + ub[k] * wb) * R));
  }
  return points;
}

// meridians and parallels of the sphere as 3D polylines
function wireframe() {
  const lines = [];
  for (let m = 0; m < 6; m++) {
    const phi = (m * Math.PI) / 6;
    lines.push(
      d3.range(0, 49).map((i) => {
        const t = (i / 48) * 2 * Math.PI;
        return [Math.cos(phi) * Math.sin(t) * R, Math.cos(t) * R, Math.sin(phi) * Math.sin(t) * R];
      }),
    );
  }
  for (const lat of [-60, -30, 0, 30, 60]) {
    const y = Math.sin((lat * Math.PI) / 180) * R;
    const r = Math.cos((lat * Math.PI) / 180) * R;
    lines.push(
      d3.range(0, 49).map((i) => {
        const t = (i / 48) * 2 * Math.PI;
        return [Math.cos(t) * r, y, Math.sin(t) * r];
      }),
    );
  }
  return lines;
}

function rotX(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, s, 0, -s, c];
}

function rotY(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

function multiply(a, b) {
  const m = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      m[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return m;
}

function apply(m, p) {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
    m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
    m[6] * p[0] + m[7] * p[1] + m[8] * p[2],
  ];
}
