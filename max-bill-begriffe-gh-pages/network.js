// Shared by station.html, grid.html and all.html: loads the CSV and draws one network.

// CSV written by the notebook (Begriffe_Analyse.ipynb, "Co-Occurrence pro Station (Lemma, Satzfenster)").
// Path is relative to the page, so the live notebook output is read (no copy to keep in sync).
const url =
  "Cooccurrence_Station_Lemma.csv";

// colors
const cInk = "#000000"; // nodes, links and labels

// sizes
const R_BEGRIFF = [8, 34]; // begriff radius range, area ~ vorkommen (min 8 so rare ones stay visible)
const STROKE_BEGRIFF = 1; // begriffe are drawn as rings
const R_WORD = [3, 14]; // word radius range, area ~ total anzahl
const DIST = [20, 200]; // link length range, from the smallest to the largest distanz in the data
const LEAF_PUSH = 15; // strength of the outward push on nodes with a single link (px per tick at full alpha)
const DIST_EXPONENT = 3; // 1 = linear, higher = only the largest distanz values get long links

function loadRows() {
  return d3.csv(url, d3.autoType);
}

// keeps the words whose cumulative anzahl (summed over all begriffe they co-occur with in
// these rows) is at least `min`; all rows of a kept word stay. Default: the "min anzahl" field.
function filterMinAnzahl(
  rows,
  min = +d3.select("#min-anzahl").property("value") || 0,
) {
  const total = d3.rollup(
    rows,
    (r) => d3.sum(r, (d) => d.anzahl),
    (d) => d.wort_b,
  );
  return rows.filter((d) => total.get(d.wort_b) >= min);
}

// all stations as one set of rows: anzahl is summed per (begriff, word), distanz is
// the mean weighted by anzahl, vorkommen the largest value of the begriff (texts can
// belong to several stations, so adding them up would count texts twice)
function aggregateRows(rows) {
  const vorkommen = new Map();
  rows.forEach((d) =>
    vorkommen.set(
      d.begriff_a,
      Math.max(vorkommen.get(d.begriff_a) ?? 0, d.vorkommen ?? 0),
    ),
  );
  return Array.from(
    d3.group(rows, (d) => d.begriff_a + "\u0000" + d.wort_b),
    ([, r]) => ({
      begriff_a: r[0].begriff_a,
      wort_b: r[0].wort_b,
      anzahl: d3.sum(r, (d) => d.anzahl),
      distanz:
        d3.sum(r, (d) => d.distanz * d.anzahl) / d3.sum(r, (d) => d.anzahl),
      vorkommen: vorkommen.get(r[0].begriff_a) || undefined,
    }),
  );
}

// begriffe and words of a set of CSV rows as nodes and links
function buildGraph(data) {
  const begriffe = Array.from(new Set(data.map((d) => d.begriff_a)));

  const nodes = begriffe.map((b) => ({
    id: "b:" + b,
    label: b,
    type: "begriff",
    total: d3.sum(
      data.filter((d) => d.begriff_a === b),
      (d) => d.anzahl,
    ),
    // occurrences of the begriff itself in the texts of the station (column "vorkommen",
    // the same in every row of a begriff); falls back to the co-occurrence sum
    vorkommen: data.find((d) => d.begriff_a === b).vorkommen,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const begriffByLower = new Map(
    begriffe.map((b) => [b.toLowerCase(), "b:" + b]),
  );

  const links = [];
  data.forEach((d) => {
    // a word that is itself a begriff of this station links to that begriff node
    const wordId = begriffByLower.get(d.wort_b) ?? "w:" + d.wort_b;
    if (!byId.has(wordId)) {
      const n = { id: wordId, label: d.wort_b, type: "wort", total: 0 };
      byId.set(wordId, n);
      nodes.push(n);
    }
    byId.get(wordId).total += d.anzahl;
    links.push({
      source: "b:" + d.begriff_a,
      target: wordId,
      anzahl: d.anzahl,
      distanz: d.distanz,
    });
  });
  return { nodes, links, begriffe: nodes.filter((n) => n.type === "begriff") };
}

// Draws the network of `data` (CSV rows, already filtered) into the <svg> element `svgEl`
// and returns the running simulation (call .stop() before redrawing).
// begriffe are pinned on a circle, words float in between.
// Without marginX/marginY the begriffe sit on a circle, with them on an ellipse that uses
// the full width and height of the area (for wide tiles).
function drawNetwork(
  svgEl,
  data,
  { width, height, margin = 90, marginX, marginY } = {},
) {
  const svg = d3.select(svgEl).attr("viewBox", [0, 0, width, height]);
  svg.selectAll("*").remove();

  const { nodes, links, begriffe } = buildGraph(data);
  if (!nodes.length) return null;

  // pin the begriffe on a circle (or ellipse) around the center, as far apart as the area allows
  const circle = Math.min(width, height) / 2 - margin;
  const ringX = marginX != null ? width / 2 - marginX : circle;
  const ringY = marginY != null ? height / 2 - marginY : circle;
  begriffe.forEach((b, i) => {
    if (begriffe.length === 1) {
      b.fx = width / 2;
      b.fy = height / 2;
    } else {
      const angle = (2 * Math.PI * i) / begriffe.length - Math.PI / 2;
      b.fx = width / 2 + ringX * Math.cos(angle);
      b.fy = height / 2 + ringY * Math.sin(angle);
    }
  });

  // anzahl -> node size (area), distanz -> link length
  const radiusScale = d3
    .scaleSqrt()
    .domain(
      d3.extent(
        nodes.filter((n) => n.type === "wort"),
        (n) => n.total,
      ),
    )
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
  const distanceScale = d3
    .scalePow()
    .exponent(DIST_EXPONENT)
    .domain(extentOrUnit(links.map((d) => d.distanz)))
    .range(DIST);

  // zoom and pan on a container group
  const g = svg.append("g");
  const zoom = d3
    .zoom()
    .scaleExtent([0.1, 5])
    .on("zoom", (event) => g.attr("transform", event.transform));
  svg.call(zoom);

  // nodes with a single link (counted before forceLink replaces the ids with node objects)
  const degree = new Map();
  links.forEach((l) => {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  });
  nodes.forEach((n) => (n.leaf = degree.get(n.id) === 1));

  const simulation = d3
    .forceSimulation(nodes)
    .force(
      "link",
      d3
        .forceLink(links)
        .id((d) => d.id)
        .distance((d) => distanceScale(d.distanz))
        .strength(0.9),
    )
    .force("charge", d3.forceManyBody().strength(-40))
    .force("x", d3.forceX(width / 2).strength(0.02))
    .force("y", d3.forceY(height / 2).strength(0.02))
    .force("leafOutward", forceLeafOutward(nodes, width / 2, height / 2, LEAF_PUSH));

  const link = g
    .append("g")
    .selectAll("line")
    .data(links)
    .enter()
    .append("line")
    .attr("stroke", cInk)
    .attr("stroke-opacity", 0.25)
    .attr("stroke-width", 1);

  const node = g
    .append("g")
    .selectAll("circle")
    .data(nodes)
    .enter()
    .append("circle")
    .attr("r", (d) => d.r)
    // begriffe: thick ring with white fill (hides the links ending in the center), words: filled dots
    .attr("fill", (d) => (d.type === "begriff" ? "#ffffff" : cInk))
    .attr("stroke", cInk)
    .attr("stroke-width", (d) => (d.type === "begriff" ? STROKE_BEGRIFF : 0))
    .call(
      d3
        .drag()
        .on("start", dragstarted)
        .on("drag", dragged)
        .on("end", dragended),
    );
  node
    .append("title")
    .text((d) =>
      d.type === "begriff"
        ? `${d.label}: ${d.vorkommen ?? "?"} Vorkommen, ${d.total} Co-Occurrences`
        : `${d.label}: ${d.total}`,
    );

  const label = g
    .append("g")
    .selectAll("text")
    .data(nodes)
    .enter()
    .append("text")
    .attr("dx", (d) => d.r + 4)
    .attr("dy", ".35em")
    .attr("fill", cInk)
    .attr("font-size", (d) => (d.type === "begriff" ? 14 : null))
    .attr("font-weight", (d) => (d.type === "begriff" ? "bold" : null))
    .text((d) => d.label.toUpperCase());

  // anzahl of the links of the selected node: written into the circle of a connected begriff,
  // and after the label of a connected word
  const countText = g
    .append("g")
    .selectAll("text")
    .data(begriffe)
    .enter()
    .append("text")
    .attr("text-anchor", "middle")
    .attr("dy", ".35em")
    .attr("font-weight", "bold")
    .attr("font-size", (d) => Math.min(12, d.r * 0.9))
    .attr("fill", cInk)
    .style("display", "none");

  // click a node to highlight it, its links and the nodes at their other ends; everything
  // else is dimmed. Click it again or the background to clear.
  let selected = null;
  function highlight() {
    const connected = new Set();
    if (selected) {
      connected.add(selected.id);
      links.forEach((l) => {
        if (l.source === selected) connected.add(l.target.id);
        if (l.target === selected) connected.add(l.source.id);
      });
    }
    const on = (d) => !selected || connected.has(d.id);
    const own = (l) => l.source === selected || l.target === selected;
    node.attr("opacity", (d) => (on(d) ? 1 : 0.1));
    label.attr("opacity", (d) => (on(d) ? 1 : 0.1));
    link.attr("stroke-opacity", (l) =>
      !selected ? 0.25 : own(l) ? 0.9 : 0.03,
    );

    // sum of anzahl between the selected node and each neighbor
    const anzahl = new Map();
    links.filter(own).forEach((l) => {
      const other = l.source === selected ? l.target : l.source;
      anzahl.set(other.id, (anzahl.get(other.id) ?? 0) + l.anzahl);
    });
    countText
      .style("display", (d) => (anzahl.has(d.id) ? null : "none"))
      .text((d) => anzahl.get(d.id));
    label.text((d) =>
      d.type === "wort" && anzahl.has(d.id)
        ? `${d.label.toUpperCase()} · ${anzahl.get(d.id)}`
        : d.label.toUpperCase(),
    );
  }
  node.style("cursor", "pointer").on("click", (event, d) => {
    event.stopPropagation();
    selected = selected === d ? null : d;
    highlight();
  });
  svg.on("click", () => {
    selected = null;
    highlight();
  });

  // each node occupies its dot plus its label, so measure the label once
  const pad = 2;
  label.each(function (d) {
    const fontSize = parseFloat(getComputedStyle(this).fontSize);
    const half = Math.max(d.r, fontSize / 2);
    d.left = -d.r - pad;
    d.right = d.r + 4 + this.getComputedTextLength() + pad;
    d.top = -half - pad;
    d.bottom = half + pad;
  });
  simulation.force("labelCollide", forceLabelCollide(nodes));

  simulation.on("tick", () => {
    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);
    node.attr("cx", (d) => d.x).attr("cy", (d) => d.y);
    countText.attr("x", (d) => d.x).attr("y", (d) => d.y);
    label.attr("x", (d) => d.x).attr("y", (d) => d.y);
  });

  // when the layout has settled, scale it down (never up) so everything is on screen
  simulation.on("end", () => {
    const x0 = d3.min(nodes, (d) => d.x + d.left);
    const x1 = d3.max(nodes, (d) => d.x + d.right);
    const y0 = d3.min(nodes, (d) => d.y + d.top);
    const y1 = d3.max(nodes, (d) => d.y + d.bottom);
    const margin = 30;
    const k = Math.min(
      1,
      (width - 2 * margin) / (x1 - x0),
      (height - 2 * margin) / (y1 - y0),
    );
    const t = d3.zoomIdentity
      .translate(width / 2, height / 2)
      .scale(k)
      .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    svg.transition().duration(500).call(zoom.transform, t);
  });

  return simulation;

  function dragstarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }

  function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }

  function dragended(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    // a begriff stays pinned where it was dropped, words are released
    if (d.type !== "begriff") {
      d.fx = null;
      d.fy = null;
    }
  }
}

// rectangular collision: move overlapping node+label boxes apart along the
// axis where they overlap least. Positions are corrected directly (not via
// velocity, which overshoots and makes nodes jitter) and not scaled by alpha,
// so overlaps are still resolved while the simulation cools down.
function forceLabelCollide(nodes) {
  return function force() {
    for (let k = 0; k < 3; k++) {
      // sweep along x: a box can only overlap boxes that start before its right edge
      const sorted = nodes
        .slice()
        .sort((a, b) => a.x + a.left - (b.x + b.left));
      for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i];
        for (let j = i + 1; j < sorted.length; j++) {
          const b = sorted[j];
          if (b.x + b.left >= a.x + a.right) break;
          const overlapX =
            Math.min(a.x + a.right, b.x + b.right) -
            Math.max(a.x + a.left, b.x + b.left);
          const overlapY =
            Math.min(a.y + a.bottom, b.y + b.bottom) -
            Math.max(a.y + a.top, b.y + b.top);
          if (overlapX <= 0 || overlapY <= 0) continue;
          // a pinned node does not move, the other one takes it all
          const wa = a.fx != null ? 0 : b.fx != null ? 1 : 0.5;
          const wb = a.fx != null && b.fx != null ? 0 : 1 - wa;
          if (overlapX < overlapY) {
            const dir = a.x < b.x ? -1 : 1;
            a.x += dir * overlapX * wa;
            b.x -= dir * overlapX * wb;
          } else {
            const dir = a.y < b.y ? -1 : 1;
            a.y += dir * overlapY * wa;
            b.y -= dir * overlapY * wb;
          }
        }
      }
    }
  };
}

// [min, max] of the values, widened to a non-empty range if they are all equal
function extentOrUnit(values) {
  const [min, max] = d3.extent(values);
  return min === max ? [min, min + 1] : [min, max];
}

// pushes nodes with a single link away from the center (cx, cy). Like the link force it
// scales with alpha; measured in station 4 a push of 40 moved the leaves about 100px further out.
function forceLeafOutward(nodes, cx, cy, push) {
  return function force(alpha) {
    for (const n of nodes) {
      if (!n.leaf || n.fx != null) continue;
      const dx = n.x - cx;
      const dy = n.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      n.vx += (dx / len) * push * alpha;
      n.vy += (dy / len) * push * alpha;
    }
  };
}
