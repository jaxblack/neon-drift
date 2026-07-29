import type { Track } from '../track/Track';
import type { Race } from '../game/Race';

/** 右上角小地图：赛道轮廓 + 所有车的实时位置 */
export class Minimap {
  private g: CanvasRenderingContext2D;
  private path: Path2D | null = null;
  private scale = 1;
  private ox = 0;
  private oz = 0;
  private startPt: [number, number] = [0, 0];

  constructor(private canvas: HTMLCanvasElement) {
    this.g = canvas.getContext('2d')!;
  }

  setTrack(track: Track): void {
    const pad = 12;
    const W = this.canvas.width, H = this.canvas.height;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of track.samples) {
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.z < minZ) minZ = s.z;
      if (s.z > maxZ) maxZ = s.z;
    }
    const w = maxX - minX, h = maxZ - minZ;
    this.scale = Math.min((W - pad * 2) / w, (H - pad * 2) / h);
    this.ox = pad + (W - pad * 2 - w * this.scale) / 2 - minX * this.scale;
    this.oz = pad + (H - pad * 2 - h * this.scale) / 2 - minZ * this.scale;

    const p = new Path2D();
    const step = Math.max(1, Math.floor(track.samples.length / 260));
    for (let i = 0; i < track.samples.length; i += step) {
      const s = track.samples[i];
      const [x, y] = this.toXY(s.x, s.z);
      if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
    }
    p.closePath();
    this.path = p;
    const s0 = track.sampleAt(0);
    this.startPt = this.toXY(s0.x, s0.z);
  }

  private toXY(x: number, z: number): [number, number] {
    return [x * this.scale + this.ox, z * this.scale + this.oz];
  }

  draw(race: Race): void {
    const g = this.g;
    const W = this.canvas.width, H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    if (!this.path) return;

    // 赛道
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(140,180,255,0.16)';
    g.lineWidth = 9;
    g.stroke(this.path);
    g.strokeStyle = 'rgba(34,230,255,0.55)';
    g.lineWidth = 2.2;
    g.stroke(this.path);

    // 起跑线
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(this.startPt[0], this.startPt[1], 3, 0, Math.PI * 2);
    g.fill();

    // 车辆
    const sorted = [...race.racers].sort((a, b) => (a.isPlayer ? 1 : 0) - (b.isPlayer ? 1 : 0));
    for (const r of sorted) {
      const [x, y] = this.toXY(r.kart.x, r.kart.z);
      const col = '#' + r.color.toString(16).padStart(6, '0');
      if (r.isPlayer) {
        g.beginPath();
        g.arc(x, y, 7.5, 0, Math.PI * 2);
        g.fillStyle = col + '44';
        g.fill();
      }
      g.beginPath();
      g.arc(x, y, r.isPlayer ? 4.4 : 3.2, 0, Math.PI * 2);
      g.fillStyle = col;
      g.fill();
      if (r.isPlayer) {
        g.strokeStyle = '#fff';
        g.lineWidth = 1.4;
        g.stroke();
        // 朝向指针
        const a = Math.atan2(r.kart.vx, r.kart.vz) || r.kart.heading;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.sin(a) * 9, y + Math.cos(a) * 9);
        g.strokeStyle = '#fff';
        g.lineWidth = 1.6;
        g.stroke();
      }
    }
  }
}
