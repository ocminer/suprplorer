'use strict';
// Network diagram of one model snapshot: the hidden neurons on an arc, the outputs on the right, a link
// for every hidden -> output weight of some size (colour = sign, width = size). Pure geometry for an SVG.
function diagram(frame, labels, { w = 560, h = 340 } = {}) {
  const nh = frame.neurons.length, nout = Math.max(1, frame.links.length / nh | 0);
  const hidden = frame.neurons.map((v, i) => {
    const a = (-0.42 + 0.84 * (i + 0.5) / nh) * Math.PI;     // arc on the left half
    return { x: 150 - 95 * Math.cos(a), y: h / 2 + (h / 2 - 22) * Math.sin(a), r: 3 + 6 * (v / 255), v };
  });
  const outs = Array.from({ length: nout }, (_, k) => ({ x: w - 150, y: h * (k + 1) / (nout + 1), label: (labels || [])[k] || 'output ' + k }));
  const links = [];
  for (let k = 0; k < nout; k++) {
    for (let i = 0; i < nh; i++) {
      const v = frame.links[k * nh + i];
      if (Math.abs(v) < 3) continue;
      links.push({ x1: hidden[i].x, y1: hidden[i].y, x2: outs[k].x, y2: outs[k].y, pos: v > 0, op: Math.min(0.9, Math.abs(v) / 16 + 0.08),
        sw: 0.6 + Math.abs(v) / 6 });
    }
  }
  return { w, h, hidden, outs, links };
}
module.exports = { diagram };
