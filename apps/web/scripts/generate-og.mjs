import resvg from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'fs';

const svg = readFileSync('public/og/challenge.svg', 'utf8');
const { Resvg } = await import('@resvg/resvg-js');
const r = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } });
const png = r.render().asPng();
writeFileSync('public/og/challenge.png', png);
console.log('Generated public/og/challenge.png (' + png.length + ' bytes)');
