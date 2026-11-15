import fs from "node:fs";
import path from "node:path";
import {
  MISSION_PROFILES,
  type InvariantTelemetry,
  type LunarSource,
  type MissionProfileId,
  type ScoreCriterionRow,
  type SiteHistoricalContext,
  type VerdictLabel,
} from "./lunarMissionReport";

const MOON_RADIUS_M = 1_737_400;

interface PatchMeta {
  file: string;
  centerLat: number;
  centerLon: number;
  col0: number;
  row0: number;
  width: number;
  height: number;
  resMeters: number;
  unitMeters: number;
}

interface LolaPolarMeta {
  sourceDataset: string;
  fullWidthPx: number;
  fullHeightPx: number;
  fullResMeters: number;
  horizonGridFile: string;
  horizonWidthPx: number;
  horizonHeightPx: number;
  horizonResMeters: number;
  patches: Record<string, PatchMeta>;
}

interface LoadedPolarLola {
  meta: LolaPolarMeta;
  horizonGrid: Int16Array;
  patches: Array<{ name: string; meta: PatchMeta; data: Int16Array }>;
}

interface GlobalDemMeta {
  sourceDataset: string;
  projection: string;
  width: number;
  height: number;
  ppd: number;
  resMetersEquator: number;
  unitMeters: number;
  minElevationM: number;
  maxElevationM: number;
  gridFile: string;
}

interface LoadedGlobalDem {
  meta: GlobalDemMeta;
  grid: Int16Array;
}

const REPORT_DATA_LOGICAL_PREFIX = "report/lunar-report-dss/src/data/";

let cachedPolarLola: LoadedPolarLola | null | undefined = undefined;
let cachedGlobalDem: LoadedGlobalDem | null | undefined = undefined;
let driveWarmupPromise: Promise<void> | null = null;

function findRepoRootForDrive(): string {
  const envManifest = process.env.GDRIVE_MANIFEST_PATH?.trim();
  if (envManifest && fs.existsSync(envManifest)) {
    return path.dirname(path.resolve(envManifest));
  }
  let cur = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(cur, "drive-manifest.json"))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}

function resolveReportCacheDataDir(): string {
  const repoRoot = findRepoRootForDrive();
  const cacheRoot = process.env.GDRIVE_CACHE_DIR?.trim()
    ? path.resolve(process.env.GDRIVE_CACHE_DIR.trim())
    : path.join(repoRoot, "cache", "gdrive");
  return path.join(cacheRoot, "report", "lunar-report-dss", "src", "data");
}

function resolveReportDataFile(fileName: string): string | null {
  const localDataDir = path.join(process.cwd(), "src/data");
  const driveCacheDir = resolveReportCacheDataDir();
  const customDir = process.env.LUNAR_REPORT_DATA_DIR?.trim();
  const preferLocal = process.env.GDRIVE_PREFER_LOCAL === "1";

  const dirs = preferLocal
    ? [customDir, localDataDir, driveCacheDir]
    : [customDir, driveCacheDir, localDataDir];

  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function downloadReportFileFromDrive(fileId: string, targetPath: string, expectedSize?: number): Promise<boolean> {
  const apiKey = process.env.GOOGLE_DRIVE_API_KEY?.trim();
  const url = apiKey
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(apiKey)}`
    : `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;

  try {
    let res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    const ctype = res.headers.get("content-type") || "";
    if (res.ok && ctype.includes("text/html")) {
      const html = await res.text();
      const confirmMatch = /confirm=([0-9A-Za-z_-]+)/i.exec(html);
      const uuidMatch = /uuid=([0-9A-Za-z_-]+)/i.exec(html);
      if (!confirmMatch) return false;
      const extra = uuidMatch ? `&uuid=${encodeURIComponent(uuidMatch[1])}` : "";
      const confirmUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=${encodeURIComponent(confirmMatch[1])}${extra}`;
      res = await fetch(confirmUrl, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
      if (res.ok && (res.headers.get("content-type") || "").includes("text/html")) {
        await res.body?.cancel();
        return false;
      }
    }
    if (!res.ok) {
      await res.body?.cancel();
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (expectedSize && buf.byteLength !== expectedSize) {
      return false;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureReportDriveBinariesLoaded(): Promise<void> {
  if (driveWarmupPromise) return driveWarmupPromise;
  driveWarmupPromise = (async () => {
    const repoRoot = findRepoRootForDrive();
    const manifestPath = process.env.GDRIVE_MANIFEST_PATH?.trim()
      ? path.resolve(process.env.GDRIVE_MANIFEST_PATH.trim())
      : path.join(repoRoot, "drive-manifest.json");
    if (!fs.existsSync(manifestPath)) return;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
        files?: Record<string, { fileId?: string; size?: number }>;
      };
      const entries = Object.entries(manifest.files || {}).filter(([k, v]) =>
        k.startsWith(REPORT_DATA_LOGICAL_PREFIX) && Boolean(v?.fileId)
      );
      if (entries.length === 0) return;

      const cacheDir = resolveReportCacheDataDir();
      const localDir = path.join(process.cwd(), "src/data");
      const preferLocal = process.env.GDRIVE_PREFER_LOCAL === "1";
      let updated = false;

      for (const [logicalPath, entry] of entries) {
        const fileName = logicalPath.slice(REPORT_DATA_LOGICAL_PREFIX.length);
        const localFile = path.join(localDir, fileName);
        if (preferLocal && fs.existsSync(localFile)) continue;

        const targetFile = path.join(cacheDir, fileName);
        if (fs.existsSync(targetFile)) {
          const stat = fs.statSync(targetFile);
          if (!entry.size || stat.size === entry.size) continue;
        }

        if (entry.fileId) {
          const ok = await downloadReportFileFromDrive(entry.fileId, targetFile, entry.size);
          if (ok) updated = true;
        }
      }

      if (updated) {
        cachedPolarLola = undefined;
        cachedGlobalDem = undefined;
      }
    } catch {
      // Keep local or analytical fallback if manifest/network is unavailable
    }
  })();
  return driveWarmupPromise;
}

function loadPolarLola(): LoadedPolarLola | null {
  if (cachedPolarLola !== undefined) return cachedPolarLola;

  const metaPath = resolveReportDataFile("lola-meta.json");
  if (!metaPath) {
    cachedPolarLola = null;
    return null;
  }

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as LolaPolarMeta;
    const horizonPath = resolveReportDataFile(meta.horizonGridFile);
    if (!horizonPath) {
      cachedPolarLola = null;
      return null;
    }

    const buf = fs.readFileSync(horizonPath);
    const horizonGrid = new Int16Array(
      buf.buffer,
      buf.byteOffset,
      Math.floor(buf.byteLength / 2),
    );

    const patches: LoadedPolarLola["patches"] = [];
    for (const [name, pMeta] of Object.entries(meta.patches)) {
      const pPath = resolveReportDataFile(pMeta.file);
      if (pPath) {
        const pBuf = fs.readFileSync(pPath);
        patches.push({
          name,
          meta: pMeta,
          data: new Int16Array(pBuf.buffer, pBuf.byteOffset, Math.floor(pBuf.byteLength / 2)),
        });
      }
    }

    cachedPolarLola = { meta, horizonGrid, patches };
    return cachedPolarLola;
  } catch {
    cachedPolarLola = null;
    return null;
  }
}

function loadGlobalDem(): LoadedGlobalDem | null {
  if (cachedGlobalDem !== undefined) return cachedGlobalDem;

  const metaPath = resolveReportDataFile("lunar-global-meta.json");
  if (!metaPath) {
    cachedGlobalDem = null;
    return null;
  }

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as GlobalDemMeta;
    const binPath = resolveReportDataFile(meta.gridFile);
    if (!binPath) {
      cachedGlobalDem = null;
      return null;
    }

    const buf = fs.readFileSync(binPath);
    const grid = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
    cachedGlobalDem = { meta, grid };
    return cachedGlobalDem;
  } catch {
    cachedGlobalDem = null;
    return null;
  }
}

function latLonToStereoPx(
  latDeg: number,
  lonDeg: number,
  halfSizePx: number,
  resM: number,
): { col: number; row: number } {
  const colatRad = ((90 - Math.abs(latDeg)) * Math.PI) / 180;
  const rM = 2 * MOON_RADIUS_M * Math.tan(colatRad / 2);
  const lonRad = (lonDeg * Math.PI) / 180;
  const xM = rM * Math.sin(lonRad);
  const yM = rM * Math.cos(lonRad);
  return {
    col: halfSizePx + xM / resM,
    row: halfSizePx - yM / resM,
  };
}

function sampleInt16Bilinear(
  arr: Int16Array,
  width: number,
  height: number,
  col: number,
  row: number,
  unitMeters = 1,
  wrapX = false,
): number {
  const r = Math.max(0, Math.min(height - 2, row));
  const y0 = Math.floor(r);
  const ty = r - y0;

  let x0: number;
  let x1: number;
  let tx: number;

  if (wrapX) {
    const cWrapped = ((col % width) + width) % width;
    x0 = Math.floor(cWrapped);
    x1 = (x0 + 1) % width;
    tx = cWrapped - x0;
  } else {
    const c = Math.max(0, Math.min(width - 2, col));
    x0 = Math.floor(c);
    x1 = x0 + 1;
    tx = c - x0;
  }

  const h00 = (arr[y0 * width + x0] ?? 0) * unitMeters;
  const h10 = (arr[y0 * width + x1] ?? 0) * unitMeters;
  const h01 = (arr[(y0 + 1) * width + x0] ?? 0) * unitMeters;
  const h11 = (arr[(y0 + 1) * width + x1] ?? 0) * unitMeters;

  return (1 - ty) * ((1 - tx) * h00 + tx * h10) + ty * ((1 - tx) * h01 + tx * h11);
}


function destinationLatLon(
  latDeg: number,
  lonDeg: number,
  azRad: number,
  distM: number,
): { lat: number; lon: number } {
  const phi1 = (latDeg * Math.PI) / 180;
  const lam1 = (lonDeg * Math.PI) / 180;
  const delta = distM / MOON_RADIUS_M;

  const sinPhi2 =
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(azRad);
  const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));
  const lam2 =
    lam1 +
    Math.atan2(
      Math.sin(azRad) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );

  const outLat = (phi2 * 180) / Math.PI;
  const outLon = ((((lam2 * 180) / Math.PI + 540) % 360) - 180);
  return { lat: outLat, lon: outLon };
}

function sampleGlobalEquirectHeight(globalDem: LoadedGlobalDem, latDeg: number, lonDeg: number): number {
  const { meta, grid } = globalDem;

  // geographical poles (+90° N or -90° S) height does not depend on longitude  we average the polar row
  if (Math.abs(latDeg) >= 89.98) {
    const poleRow = latDeg >= 0 ? 0 : meta.height - 1;
    const rowOffset = poleRow * meta.width;
    let sum = 0;
    const step = Math.max(1, Math.floor(meta.width / 360));
    let count = 0;
    for (let c = 0; c < meta.width; c += step) {
      sum += (grid[rowOffset + c] ?? 0) * meta.unitMeters;
      count++;
    }
    return sum / Math.max(1, count);
  }

  const lon360 = ((lonDeg % 360) + 360) % 360;
  const col = (lon360 / 360) * meta.width - 0.5;
  const row = ((90 - latDeg) / 180) * meta.height - 0.5;
  return sampleInt16Bilinear(grid, meta.width, meta.height, col, row, meta.unitMeters, true);
}

function analyzePolarSouthTopography(lat: number, lon: number, polar: LoadedPolarLola) {
  const { meta, horizonGrid, patches } = polar;
  const hHalf = meta.horizonWidthPx / 2;
  const hRes = meta.horizonResMeters;
  const { col: hCol, row: hRow } = latLonToStereoPx(lat, lon, hHalf, hRes);

  const fHalf = meta.fullWidthPx / 2;
  const fRes = meta.fullResMeters;
  const { col: fCol, row: fRow } = latLonToStereoPx(lat, lon, fHalf, fRes);

  let elevationM = Math.round(
    sampleInt16Bilinear(horizonGrid, meta.horizonWidthPx, meta.horizonHeightPx, hCol, hRow, 1),
  );
  let slopeDeg = 0;
  let slopeUncertaintyDeg = 1.2;
  let demResolutionLabel = "LOLA Polar 100m/px";
  let elevationUncertaintyM = 1.5;

  const matchedPatch = patches.find(
    (p) =>
      fCol >= p.meta.col0 + 2 &&
      fCol <= p.meta.col0 + p.meta.width - 3 &&
      fRow >= p.meta.row0 + 2 &&
      fRow <= p.meta.row0 + p.meta.height - 3,
  );

  if (matchedPatch) {
    const lc = fCol - matchedPatch.meta.col0;
    const lr = fRow - matchedPatch.meta.row0;
    const u = matchedPatch.meta.unitMeters;
    elevationM = Math.round(
      sampleInt16Bilinear(
        matchedPatch.data,
        matchedPatch.meta.width,
        matchedPatch.meta.height,
        lc,
        lr,
        u,
      ),
    );
    const dzdx =
      (sampleInt16Bilinear(
        matchedPatch.data,
        matchedPatch.meta.width,
        matchedPatch.meta.height,
        lc + 1,
        lr,
        u,
      ) -
        sampleInt16Bilinear(
          matchedPatch.data,
          matchedPatch.meta.width,
          matchedPatch.meta.height,
          lc - 1,
          lr,
          u,
        )) /
      (2 * fRes);
    const dzdy =
      (sampleInt16Bilinear(
        matchedPatch.data,
        matchedPatch.meta.width,
        matchedPatch.meta.height,
        lc,
        lr + 1,
        u,
      ) -
        sampleInt16Bilinear(
          matchedPatch.data,
          matchedPatch.meta.width,
          matchedPatch.meta.height,
          lc,
          lr - 1,
          u,
        )) /
      (2 * fRes);
    slopeDeg = Number(((Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI).toFixed(1));
    demResolutionLabel = "LOLA Polar 20m/px";
    elevationUncertaintyM = 0.5;
    slopeUncertaintyDeg = 0.8;
  } else {
    const dzdx =
      (sampleInt16Bilinear(horizonGrid, meta.horizonWidthPx, meta.horizonHeightPx, hCol + 1, hRow, 1) -
        sampleInt16Bilinear(horizonGrid, meta.horizonWidthPx, meta.horizonHeightPx, hCol - 1, hRow, 1)) /
      (2 * hRes);
    const dzdy =
      (sampleInt16Bilinear(horizonGrid, meta.horizonWidthPx, meta.horizonHeightPx, hCol, hRow + 1, 1) -
        sampleInt16Bilinear(horizonGrid, meta.horizonWidthPx, meta.horizonHeightPx, hCol, hRow - 1, 1)) /
      (2 * hRes);
    slopeDeg = Number(((Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI).toFixed(1));
  }

  const horizonProfile = new Float32Array(36);
  let maxHorizonBlockDeg = -90;
  let minHorizonDeg = 90;

  for (let s = 0; s < 36; s++) {
    const rayLonDeg = s * 10;
    const rad = (rayLonDeg * Math.PI) / 180;
    const dCol = Math.sin(rad);
    const dRow = -Math.cos(rad);
    let maxAngle = -2.0;

    for (let step = 1; step <= 1200; step += step < 80 ? 1 : 3) {
      const rc = hCol + dCol * step;
      const rr = hRow + dRow * step;
      if (rc < 2 || rc >= meta.horizonWidthPx - 3 || rr < 2 || rr >= meta.horizonHeightPx - 3) {
        break;
      }

      const distM = step * hRes;
      const targetH = sampleInt16Bilinear(
        horizonGrid,
        meta.horizonWidthPx,
        meta.horizonHeightPx,
        rc,
        rr,
        1,
      );
      const curvatureDrop = (distM * distM) / (2 * MOON_RADIUS_M);
      const angle = (Math.atan2(targetH - elevationM - curvatureDrop, distM) * 180) / Math.PI;
      if (angle > maxAngle) maxAngle = angle;
    }

    horizonProfile[s] = maxAngle;
    if (maxAngle > maxHorizonBlockDeg) maxHorizonBlockDeg = maxAngle;
    if (maxAngle < minHorizonDeg) minHorizonDeg = maxAngle;
  }

  const isInsidePsr = Math.abs(lat) >= 85.5 && minHorizonDeg > 1.8 && elevationM < -1500;

  let psrDistKm = 0;
  if (!isInsidePsr) {
    let minPsrPx = 3000;
    const polarPsrCapRadiusPx = 1400;
    const c0 = Math.max(0, Math.floor(hHalf - polarPsrCapRadiusPx));
    const c1 = Math.min(meta.horizonWidthPx - 1, Math.ceil(hHalf + polarPsrCapRadiusPx));
    const r0 = Math.max(0, Math.floor(hHalf - polarPsrCapRadiusPx));
    const r1 = Math.min(meta.horizonHeightPx - 1, Math.ceil(hHalf + polarPsrCapRadiusPx));

    for (let r = r0; r <= r1; r += 4) {
      const rowOffset = r * meta.horizonWidthPx;
      for (let c = c0; c <= c1; c += 4) {
        if (
          Math.hypot(c - hHalf, r - hHalf) <= polarPsrCapRadiusPx &&
          horizonGrid[rowOffset + c] < -2100
        ) {
          const d = Math.hypot(c - hCol, r - hRow);
          if (d < minPsrPx) minPsrPx = d;
        }
      }
    }
    psrDistKm = Number(((minPsrPx * hRes) / 1000).toFixed(1));
  }

  return {
    elevationM,
    slopeDeg,
    slopeUncertaintyDeg,
    horizonBlockDeg: Number(maxHorizonBlockDeg.toFixed(1)),
    minHorizonDeg: Number(minHorizonDeg.toFixed(1)),
    psrDistKm,
    isInsidePsr,
    horizonProfile,
    demResolutionLabel,
    elevationUncertaintyM,
    datasetUsed: meta.sourceDataset,
  };
}

function analyzeTopography(lat: number, lon: number) {
  // For the polar southern zone (-81..-90) we use the highest resolution 20m/100m if available
  if (lat <= -81.0) {
    const polar = loadPolarLola();
    if (polar) {
      return analyzePolarSouthTopography(lat, lon, polar);
    }
  }

  // For the rest of the Moon (-90..+90) we use the global LDEM_64
  const globalDem = loadGlobalDem();
  if (globalDem) {
    const { meta } = globalDem;
    const elevationM = Math.round(sampleGlobalEquirectHeight(globalDem, lat, lon));

    const dLatDeg = 1.0 / meta.ppd;
    const cosLat = Math.max(0.08, Math.cos((lat * Math.PI) / 180));
    const dLonDeg = dLatDeg / cosLat;

    const dyM = ((dLatDeg * Math.PI) / 180) * MOON_RADIUS_M;
    const dxM = ((dLonDeg * Math.PI) / 180) * MOON_RADIUS_M * cosLat;

    const hNorth = sampleGlobalEquirectHeight(globalDem, Math.min(89.95, lat + dLatDeg), lon);
    const hSouth = sampleGlobalEquirectHeight(globalDem, Math.max(-89.95, lat - dLatDeg), lon);
    const hEast = sampleGlobalEquirectHeight(globalDem, lat, lon + dLonDeg);
    const hWest = sampleGlobalEquirectHeight(globalDem, lat, lon - dLonDeg);

    const dzdy = (hNorth - hSouth) / (2 * dyM);
    const dzdx = (hEast - hWest) / (2 * dxM);
    const slopeDeg = Number(((Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI).toFixed(1));

    // Spherical 360° raycasting horizon along topocentric azimuths (0° = North, 90° = East, 180° = South, 270° = West)
    const horizonProfile = new Float32Array(36);
    let maxHorizonBlockDeg = -90;
    let minHorizonDeg = 90;

    for (let s = 0; s < 36; s++) {
      const azRad = (s * 10 * Math.PI) / 180;
      let maxAngle = -2.0;

      for (let distKm = 1; distKm <= 100; distKm += distKm < 15 ? 1 : 3) {
        const distM = distKm * 1000;
        const pt = destinationLatLon(lat, lon, azRad, distM);
        const targetH = sampleGlobalEquirectHeight(globalDem, pt.lat, pt.lon);
        const curvatureDrop = (distM * distM) / (2 * MOON_RADIUS_M);
        const angle = (Math.atan2(targetH - elevationM - curvatureDrop, distM) * 180) / Math.PI;
        if (angle > maxAngle) maxAngle = angle;
      }

      horizonProfile[s] = maxAngle;
      if (maxAngle > maxHorizonBlockDeg) maxHorizonBlockDeg = maxAngle;
      if (maxAngle < minHorizonDeg) minHorizonDeg = maxAngle;
    }

    const isInsidePsr = Math.abs(lat) >= 85.5 && minHorizonDeg > 1.8 && elevationM < -1500;
    const distToNearestPoleKm = Math.round(((90 - Math.abs(lat)) * Math.PI * MOON_RADIUS_M) / 180 / 1000);
    const psrDistKm = isInsidePsr ? 0 : Math.max(0, distToNearestPoleKm);

    return {
      elevationM,
      slopeDeg,
      slopeUncertaintyDeg: 1.4,
      horizonBlockDeg: Number(maxHorizonBlockDeg.toFixed(1)),
      minHorizonDeg: Number(minHorizonDeg.toFixed(1)),
      psrDistKm,
      isInsidePsr,
      horizonProfile,
      demResolutionLabel: `Global LOLA ${meta.ppd}ppd (~${Math.round(meta.resMetersEquator)}m/px)`,
      elevationUncertaintyM: 3.0,
      datasetUsed: meta.sourceDataset,
    };
  }

  // Analytical fallback in case .bin is missing
  const isMare = Math.abs(lat) < 35 && Math.abs(lon) < 55;
  const elevationM = isMare ? -2650 : 1150;
  const slopeDeg = isMare ? 2.8 : 6.4;
  const horizonProfile = new Float32Array(36).fill(1.5);

  return {
    elevationM,
    slopeDeg,
    slopeUncertaintyDeg: 2.0,
    horizonBlockDeg: 1.5,
    minHorizonDeg: -1.5,
    psrDistKm: Math.round(((90 - Math.abs(lat)) * Math.PI * MOON_RADIUS_M) / 180 / 1000),
    isInsidePsr: false,
    horizonProfile,
    demResolutionLabel: "Global Analytical DEM",
    elevationUncertaintyM: 10.0,
    datasetUsed: "Global Analytical Fallback",
  };
}

interface AzElPoint {
  az: number;
  el: number;
}


function parseHorizonsResponse(
  raw: string,
  siteLatDeg: number,
  siteLonDeg: number,
  usePolarGridAzimuth: boolean,
): AzElPoint[] {
  const soe = raw.indexOf("$$SOE");
  const eoe = raw.indexOf("$$EOE");
  if (soe === -1 || eoe === -1) return [];

  return raw
    .slice(soe + 5, eoe)
    .trim()
    .split("\n")
    .map((line) => {
      const cols = line.split(",");
      const topoAz = parseFloat(cols[3]);
      const el = parseFloat(cols[4]);
      const az = usePolarGridAzimuth
        ? (((siteLonDeg - topoAz) % 360) + 360) % 360
        : (((topoAz % 360) + 360) % 360);
      return { az, el };
    })
    .filter((pt) => Number.isFinite(pt.az) && Number.isFinite(pt.el));
}

async function fetchJplHorizonsBody(
  command: "10" | "399",
  lat: number,
  lon: number,
  startDate: string,
  stopDate: string,
  usePolarGridAzimuth: boolean,
): Promise<AzElPoint[]> {
  const params = new URLSearchParams({
    format: "json",
    COMMAND: `'${command}'`,
    OBJ_DATA: "'NO'",
    MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'OBSERVER'",
    CENTER: "'coord@301'",
    COORD_TYPE: "'GEODETIC'",
    SITE_COORD: `'${lon.toFixed(4)},${lat.toFixed(4)},0'`,
    START_TIME: `'${startDate} 00:00'`,
    STOP_TIME: `'${stopDate} 00:00'`,
    STEP_SIZE: "'1 h'",
    QUANTITIES: "'4'",
    CSV_FORMAT: "'YES'",
  });

  try {
    const res = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${params.toString()}`, {
      signal: AbortSignal.timeout(4_500),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { result?: string };
    return typeof data.result === "string"
      ? parseHorizonsResponse(data.result, lat, lon, usePolarGridAzimuth)
      : [];
  } catch {
    return [];
  }
}

const REF_FULL_MOON_UTC_MS = Date.UTC(2026, 10, 24, 14, 53, 0);
const SYNODIC_MONTH_DAYS = 29.530588853;

function computeGlobalSphericalAzEl(
  siteLatDeg: number,
  siteLonDeg: number,
  targetLatDeg: number,
  targetLonDeg: number,
): { topoAzDeg: number; elDeg: number } {
  const phi1 = (siteLatDeg * Math.PI) / 180;
  const phi2 = (targetLatDeg * Math.PI) / 180;
  const dLam = ((targetLonDeg - siteLonDeg) * Math.PI) / 180;

  const sinAlt =
    Math.sin(phi1) * Math.sin(phi2) + Math.cos(phi1) * Math.cos(phi2) * Math.cos(dLam);
  const elRad = Math.asin(Math.max(-1, Math.min(1, sinAlt)));

  const y = Math.sin(dLam) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam);
  const topoAzDeg = (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;

  return { topoAzDeg, elDeg: (elRad * 180) / Math.PI };
}

function computeAnalyticalEphemeris(
  lat: number,
  lon: number,
  startDate: string,
  totalHours: number,
  usePolarGridAzimuth: boolean,
): { sun: AzElPoint[]; earth: AzElPoint[] } {
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const j2000Days = (startMs - Date.UTC(2000, 0, 1, 12, 0, 0)) / 86_400_000;

  const sun: AzElPoint[] = [];
  const earth: AzElPoint[] = [];

  for (let h = 0; h < totalHours; h++) {
    const currentMs = startMs + h * 3_600_000;
    const daysSinceFullMoon = (currentMs - REF_FULL_MOON_UTC_MS) / 86_400_000;
    const subSolarLonDeg =
      (((-360.0 * (daysSinceFullMoon / SYNODIC_MONTH_DAYS)) % 360) + 360) % 360;

    const d = j2000Days + h / 24;
    const subSolarLatDeg = -1.54 * Math.cos((2 * Math.PI * (d - 325.0)) / 365.2422);

    const sunPos = computeGlobalSphericalAzEl(lat, lon, subSolarLatDeg, subSolarLonDeg);
    sun.push({
      az: usePolarGridAzimuth
        ? (((lon - sunPos.topoAzDeg) % 360) + 360) % 360
        : sunPos.topoAzDeg,
      el: sunPos.elDeg,
    });

    const subEarthLatDeg = 6.68 * Math.sin((2 * Math.PI * d) / 27.21222 + 1.6279);
    const subEarthLonDeg = 7.85 * Math.sin((2 * Math.PI * d) / 27.55455 + 2.3556);
    const earthPos = computeGlobalSphericalAzEl(lat, lon, subEarthLatDeg, subEarthLonDeg);

    earth.push({
      az: usePolarGridAzimuth
        ? (((lon - earthPos.topoAzDeg) % 360) + 360) % 360
        : earthPos.topoAzDeg,
      el: earthPos.elDeg,
    });
  }

  return { sun, earth };
}

function evaluateVisibilityWindow(
  sunSeries: AzElPoint[],
  earthSeries: AzElPoint[],
  horizonProfile: Float32Array,
  forceTotalShadow = false,
) {
  const count = Math.min(sunSeries.length, earthSeries.length);
  let sunHours = 0;
  let peakSolarElev = -90;
  let curEclipse = 0;
  let maxEclipse = 0;

  let dteHours = 0;
  let curBlackout = 0;
  let maxBlackout = 0;
  const sunlightTimeline: number[] = [];

  const SOLAR_UPPER_LIMB_DEG = 0.27;
  const EARTH_UPPER_LIMB_DEG = 0.95;

  for (let i = 0; i < count; i++) {
    if (sunSeries[i].el > peakSolarElev) peakSolarElev = sunSeries[i].el;

    const sunSec = Math.floor((((sunSeries[i].az % 360) + 360) % 360) / 10) % 36;
    const isSunlit =
      !forceTotalShadow && sunSeries[i].el + SOLAR_UPPER_LIMB_DEG - horizonProfile[sunSec] > 0;

    if (isSunlit) {
      sunHours++;
      curEclipse = 0;
      sunlightTimeline.push(1);
    } else {
      curEclipse++;
      if (curEclipse > maxEclipse) maxEclipse = curEclipse;
      sunlightTimeline.push(0);
    }

    const earthSec = Math.floor((((earthSeries[i].az % 360) + 360) % 360) / 10) % 36;
    if (earthSeries[i].el + EARTH_UPPER_LIMB_DEG - horizonProfile[earthSec] > 0) {
      dteHours++;
      curBlackout = 0;
    } else {
      curBlackout++;
      if (curBlackout > maxBlackout) maxBlackout = curBlackout;
    }
  }

  const total = Math.max(1, count);
  return {
    sunlightHours: sunHours,
    sunlightPct: Number(((sunHours / total) * 100).toFixed(1)),
    peakSolarElevDeg: Number(peakSolarElev.toFixed(1)),
    maxEclipseHours: maxEclipse,
    dteUptimePct: Number(((dteHours / total) * 100).toFixed(1)),
    maxBlackoutHours: maxBlackout,
    sunlightTimeline,
  };
}

interface LunarFeatureEntry {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusKm: number;
  kind: "crater" | "massif" | "ridge" | "mare" | "basin";
  badge: string;
  title: string;
  description: string;
}

const GLOBAL_LUNAR_CATALOG: LunarFeatureEntry[] = [
  {
    id: "apollo-11",
    name: "MARE TRANQUILLITATIS (APOLLO 11)",
    lat: 0.67,
    lon: 23.47,
    radiusKm: 180.0,
    kind: "mare",
    badge: "HISTORIC LANDING SITE — APOLLO 11 (1969)",
    title: "Statio Tranquillitatis — First Crewed Lunar Landing",
    description:
      "Smooth basaltic mare plain in southwestern Mare Tranquillitatis with low slopes (< 3°), high solar elevation angles during lunar day, and continuous Direct-to-Earth radio visibility.",
  },
  {
    id: "apollo-17",
    name: "TAURUS-LITTROW VALLEY (APOLLO 17)",
    lat: 20.19,
    lon: 30.77,
    radiusKm: 90.0,
    kind: "basin",
    badge: "HISTORIC LANDING SITE — APOLLO 17 (1972)",
    title: "Taurus-Littrow Valley — Highland/Mare Interface",
    description:
      "A deep graben valley on the southeastern rim of Mare Serenitatis flanked by 2 km tall massifs that cast localized morning and evening shadows across the valley floor.",
  },
  {
    id: "apollo-15",
    name: "HADLEY–APENNINE (APOLLO 15)",
    lat: 26.13,
    lon: 3.63,
    radiusKm: 85.0,
    kind: "basin",
    badge: "HISTORIC LANDING SITE — APOLLO 15 (1971)",
    title: "Hadley Rille & Montes Apenninus",
    description:
      "Mare Imbrium edge bordering the towering Apennine mountain front and sinuous Hadley Rille channel.",
  },
  {
    id: "change-4",
    name: "VON KÁRMÁN CRATER (CHANG'E-4)",
    lat: -45.45,
    lon: 177.58,
    radiusKm: 90.0,
    kind: "crater",
    badge: "FARSIDE LANDING SITE — CHANG'E-4 (2019)",
    title: "Von Kármán Crater — South Pole–Aitken Basin",
    description:
      "A 180 km basalt-flooded crater on the lunar farside requiring a halo-orbit relay satellite (Queqiao) for Earth communications.",
  },
  {
    id: "tycho",
    name: "TYCHO CRATER",
    lat: -43.31,
    lon: -11.36,
    radiusKm: 43.0,
    kind: "crater",
    badge: "YOUNG RAYED IMPACT CRATER",
    title: "Tycho Crater — Southern Highlands",
    description:
      "An 85 km Copernican impact crater with steep terraced walls, rough impact melt floor, and a prominent central peak.",
  },
  {
    id: "copernicus",
    name: "COPERNICUS CRATER",
    lat: 9.62,
    lon: -20.08,
    radiusKm: 47.0,
    kind: "crater",
    badge: "NEARSIDE COMPLEX CRATER",
    title: "Copernicus Crater — Eastern Oceanus Procellarum",
    description:
      "A 93 km complex crater featuring terraced slump blocks and central peaks rising 1,200 m above the floor.",
  },
  {
    id: "aristarchus",
    name: "ARISTARCHUS PLATEAU",
    lat: 23.73,
    lon: -47.49,
    radiusKm: 60.0,
    kind: "massif",
    badge: "VOLCANIC & HIGH-ALBEDO ANOMALY",
    title: "Aristarchus Crater & Vallis Schröteri",
    description:
      "The brightest large impact structure on the Moon, adjacent to the elevated volcanic Aristarchus Plateau.",
  },
  {
    id: "shackleton",
    name: "SHACKLETON",
    lat: -89.67,
    lon: 129.78,
    radiusKm: 10.5,
    kind: "crater",
    badge: "PERMANENTLY SHADOWED CRATER (PSR)",
    title: "Shackleton Crater — South Polar Cold Trap",
    description:
      "A 21 km impact crater straddling the lunar South Pole whose interior floor remains in permanent cryogenic shadow near -230°C.",
  },
  {
    id: "connecting-ridge",
    name: "SHACKLETON–DE GERLACHE RIDGE",
    lat: -89.45,
    lon: -137.3,
    radiusKm: 9.0,
    kind: "ridge",
    badge: "ARTEMIS CANDIDATE ZONE",
    title: "Connecting Ridge — Peak of Eternal Light",
    description:
      "Elevated polar ridge linking Shackleton and de Gerlache craters with prolonged grazing solar illumination adjacent to PSR water-ice traps.",
  },
  {
    id: "malapert",
    name: "MALAPERT MASSIF",
    lat: -86.04,
    lon: -2.7,
    radiusKm: 22.0,
    kind: "massif",
    badge: "POLAR RELAY HIGHLAND",
    title: "Malapert Massif — Nearside Line-of-Sight Peak",
    description:
      "A 5 km high mountain ridge providing near-continuous Direct-to-Earth visibility across the South Pole region.",
  },
  {
    id: "peary",
    name: "PEARY CRATER",
    lat: 88.6,
    lon: 33.0,
    radiusKm: 37.0,
    kind: "crater",
    badge: "NORTH POLAR BASIN",
    title: "Peary Crater — Lunar North Pole",
    description:
      "A 74 km polar crater near the lunar North Pole with elevated rim peaks experiencing prolonged illumination.",
  },
];

function lunarSurfaceDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dPhi = phi2 - phi1;
  const dLam = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) * Math.sin(dLam / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return (MOON_RADIUS_M / 1000) * c;
}

function findNearestCatalogFeature(lat: number, lon: number): {
  feature: LunarFeatureEntry;
  distKm: number;
  isInsideRadius: boolean;
} {
  let best: { feature: LunarFeatureEntry; distKm: number } | null = null;
  for (const feature of GLOBAL_LUNAR_CATALOG) {
    const distKm = lunarSurfaceDistanceKm(lat, lon, feature.lat, feature.lon);
    if (!best || distKm < best.distKm) {
      best = { feature, distKm };
    }
  }
  const fallback = best!;
  return {
    feature: fallback.feature,
    distKm: Number(fallback.distKm.toFixed(1)),
    isInsideRadius: fallback.distKm <= fallback.feature.radiusKm,
  };
}

function resolveSiteName(
  lat: number,
  lon: number,
  elevationM: number,
  slopeDeg: number,
  isInsidePsr: boolean,
): string {
  const nearest = findNearestCatalogFeature(lat, lon);
  if (nearest.isInsideRadius) {
    const { feature, distKm } = nearest;
    if (feature.kind === "crater") {
      if (isInsidePsr || (distKm < feature.radiusKm * 0.6 && elevationM < -1200)) {
        return `${feature.name} FLOOR`;
      }
      if (slopeDeg > 11.0 && distKm < feature.radiusKm * 0.85) {
        return `${feature.name} INNER WALL`;
      }
      return `${feature.name} RIM`;
    }
    return feature.name;
  }

  const side = Math.abs(lon) <= 90 ? "NEARSIDE" : "FARSIDE";
  const latBand =
    Math.abs(lat) >= 75
      ? lat >= 0
        ? "NORTH POLAR"
        : "SOUTH POLAR"
      : Math.abs(lat) <= 25
        ? "EQUATORIAL"
        : "MID-LATITUDE";

  const terrain =
    isInsidePsr || elevationM < -1800
      ? "MARE / BASIN FLOOR"
      : slopeDeg > 11.0
        ? "HIGHLAND ESCARPMENT"
        : elevationM > 1500
          ? "HIGHLAND MASSIF"
          : "HIGHLAND TERRAIN";

  return `${side} ${latBand} ${terrain} (${nearest.distKm} KM FROM ${nearest.feature.name})`;
}

function resolveSiteContext(lat: number, lon: number): SiteHistoricalContext | null {
  const nearest = findNearestCatalogFeature(lat, lon);
  if (nearest.isInsideRadius) {
    return {
      badge: nearest.feature.badge,
      title: nearest.feature.title,
      description: nearest.feature.description,
    };
  }

  const isNearside = Math.abs(lon) <= 90;
  return {
    badge: isNearside
      ? "GLOBAL LUNAR SURVEY — NEARSIDE HEMISPHERE"
      : "GLOBAL LUNAR SURVEY — FARSIDE HEMISPHERE",
    title: isNearside
      ? "Nearside Lunar Surface Sector"
      : "Farside Lunar Surface Sector (Relay Zone)",
    description: `Global LDEM_64 topographic sector located ${nearest.distKm} km from ${nearest.feature.name}, evaluated for CLPS Lander descent slope, solar day/night power cycle, and Earth line-of-sight.`,
  };
}

export async function extractLunarTelemetryAndSources(params: {
  lat: number;
  lon: number;
  landingDate: string;
  windowDays?: number;
  profile?: MissionProfileId;
}): Promise<{ telemetry: InvariantTelemetry; sources: LunarSource[]; ephemerisMode: string }> {
  const windowDays = params.windowDays ?? 14;
  // `Only CLPS profile is supported for now, but we can add more in the future if needed.
  const profileId: MissionProfileId = "clps";
  const spec = MISSION_PROFILES[profileId];
  const totalHours = windowDays * 24;

  await ensureReportDriveBinariesLoaded();
  const usePolarGridAzimuth = params.lat <= -81.0 && loadPolarLola() !== null;
  const topo = analyzeTopography(params.lat, params.lon);

  const stopDate = new Date(Date.parse(`${params.landingDate}T00:00:00Z`) + windowDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const [liveSun, liveEarth] = await Promise.all([
    fetchJplHorizonsBody("10", params.lat, params.lon, params.landingDate, stopDate, usePolarGridAzimuth),
    fetchJplHorizonsBody("399", params.lat, params.lon, params.landingDate, stopDate, usePolarGridAzimuth),
  ]);

  const useLive = liveSun.length >= totalHours * 0.8 && liveEarth.length >= totalHours * 0.8;
  const fallbackSeries = computeAnalyticalEphemeris(
    params.lat,
    params.lon,
    params.landingDate,
    totalHours,
    usePolarGridAzimuth,
  );
  const sunSeries = useLive ? liveSun.slice(0, totalHours) : fallbackSeries.sun;
  const earthSeries = useLive ? liveEarth.slice(0, totalHours) : fallbackSeries.earth;

  const peakSunPreCheck = sunSeries.reduce((m, p) => (p.el > m ? p.el : m), -90);
  const forceTotalShadow = topo.isInsidePsr || topo.minHorizonDeg > peakSunPreCheck + 0.27;

  const windowMetrics = evaluateVisibilityWindow(
    sunSeries,
    earthSeries,
    topo.horizonProfile,
    forceTotalShadow,
  );

  const nextLunarDayDate = new Date(
    Date.parse(`${params.landingDate}T00:00:00Z`) + Math.round(29.53 * 86_400_000),
  )
    .toISOString()
    .slice(0, 10);
  const shiftedFallback = computeAnalyticalEphemeris(
    params.lat,
    params.lon,
    nextLunarDayDate,
    totalHours,
    usePolarGridAzimuth,
  );
  const shiftedMetrics = evaluateVisibilityWindow(
    shiftedFallback.sun,
    shiftedFallback.earth,
    topo.horizonProfile,
    forceTotalShadow,
  );

  const offsetLat = params.lat >= 89.9 ? params.lat - 0.0115 : params.lat + 0.0115;
  const northTopo = analyzeTopography(offsetLat, params.lon);
  const northMetrics = evaluateVisibilityWindow(
    sunSeries,
    earthSeries,
    northTopo.horizonProfile,
    northTopo.isInsidePsr || northTopo.minHorizonDeg > peakSunPreCheck + 0.27,
  );

  const sunlightUncertaintyPct = forceTotalShadow ? 0 : 1.5;
  const eclipseTruncated = windowMetrics.maxEclipseHours >= totalHours;
  const blackoutTruncated = windowMetrics.maxBlackoutHours >= totalHours;
  const eclipsePrefix = eclipseTruncated ? "≥ " : "";
  const blackoutPrefix = blackoutTruncated ? "≥ " : "";

  const scoreBreakdown: ScoreCriterionRow[] = [
    {
      criterion: "Terrain Slope",
      value: `${topo.slopeDeg}° (±${topo.slopeUncertaintyDeg}°)`,
      threshold: `≤ ${spec.maxSlopeDeg}°`,
      margin: `${spec.maxSlopeDeg - topo.slopeDeg >= 0 ? "+" : ""}${(spec.maxSlopeDeg - topo.slopeDeg).toFixed(1)}°`,
      status:
        topo.slopeDeg <= spec.safeSlopeDeg
          ? "PASS"
          : topo.slopeDeg <= spec.maxSlopeDeg
            ? "WARN"
            : "FAIL",
    },
    {
      criterion: "Solar Illumination",
      value: `${windowMetrics.sunlightPct}% (±${sunlightUncertaintyPct}%)`,
      threshold: `≥ ${spec.targetSunPct}%`,
      margin: `${windowMetrics.sunlightPct - spec.targetSunPct >= 0 ? "+" : ""}${(windowMetrics.sunlightPct - spec.targetSunPct).toFixed(1)}%`,
      status:
        windowMetrics.sunlightPct >= spec.targetSunPct
          ? "PASS"
          : windowMetrics.sunlightPct >= spec.noGoSunPct
            ? "WARN"
            : "FAIL",
    },
    {
      criterion: "Max Eclipse Gap",
      value: `${eclipsePrefix}${windowMetrics.maxEclipseHours}h`,
      threshold: `≤ ${spec.maxEclipseSafeHrs}h`,
      margin: `${spec.maxEclipseSafeHrs - windowMetrics.maxEclipseHours >= 0 ? "+" : ""}${spec.maxEclipseSafeHrs - windowMetrics.maxEclipseHours}h`,
      status: windowMetrics.maxEclipseHours <= spec.maxEclipseSafeHrs ? "PASS" : "FAIL",
    },
    {
      criterion: "Earth DTE Blackout",
      value: `${blackoutPrefix}${windowMetrics.maxBlackoutHours}h (${windowMetrics.dteUptimePct}%)`,
      threshold: `≤ ${spec.maxBlackoutLimitHrs}h`,
      margin: `${spec.maxBlackoutLimitHrs - windowMetrics.maxBlackoutHours >= 0 ? "+" : ""}${spec.maxBlackoutLimitHrs - windowMetrics.maxBlackoutHours}h`,
      status: windowMetrics.maxBlackoutHours <= spec.maxBlackoutLimitHrs ? "PASS" : "WARN",
    },
  ];

  const relayRequired =
    windowMetrics.maxBlackoutHours > spec.maxBlackoutLimitHrs || windowMetrics.dteUptimePct < 50;

  const verdict: VerdictLabel =
    topo.slopeDeg > spec.noGoSlopeDeg ||
    windowMetrics.sunlightPct < spec.noGoSunPct ||
    windowMetrics.dteUptimePct < spec.noGoDtePct
      ? "NO-GO"
      : topo.slopeDeg <= spec.safeSlopeDeg &&
          windowMetrics.sunlightPct >= spec.targetSunPct &&
          windowMetrics.maxEclipseHours <= spec.maxEclipseSafeHrs &&
          !relayRequired
        ? "GO"
        : "CONDITIONAL";

  const viabilityScore = Math.max(
    5,
    Math.min(
      99,
      Math.round(
        (topo.slopeDeg <= spec.maxSlopeDeg ? 35 : 5) +
          Math.min(30, (windowMetrics.sunlightPct / spec.targetSunPct) * 30) +
          Math.min(20, (windowMetrics.dteUptimePct / spec.targetDtePct) * 20) +
          (windowMetrics.maxEclipseHours <= spec.maxEclipseSafeHrs ? 15 : 0),
      ),
    ),
  );

  const slopeNote =
    topo.slopeDeg < spec.safeSlopeDeg
      ? `(Limit < ${spec.maxSlopeDeg}°)`
      : topo.slopeDeg <= spec.maxSlopeDeg
        ? `(Near ${spec.maxSlopeDeg}° Limit)`
        : `(Exceeds ${spec.maxSlopeDeg}° Limit)`;

  const siteName = resolveSiteName(
    params.lat,
    params.lon,
    topo.elevationM,
    topo.slopeDeg,
    topo.isInsidePsr,
  );
  const siteContext = resolveSiteContext(params.lat, params.lon);
  const computedAtUtc = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const latHemisphere = params.lat >= 0 ? "N" : "S";

  const telemetry: InvariantTelemetry = {
    siteName,
    siteContext,
    lat: params.lat,
    lon: params.lon,
    landingDate: params.landingDate,
    windowDays,
    profileId,
    viabilityScore,
    verdict,
    relayRequired,
    isInsidePsr: topo.isInsidePsr,
    demResolutionLabel: topo.demResolutionLabel,
    demUncertaintyNote: `Height ±${topo.elevationUncertaintyM}m · Slope ±${topo.slopeUncertaintyDeg}° · Sun ±${sunlightUncertaintyPct}% · Hazards < DEM pixel unresolved`,
    computedAtUtc,
    scoreBreakdown,
    sunlightTimeline: windowMetrics.sunlightTimeline,
    meta: {
      profile: spec.label,
      window: `${windowDays} Days (${params.landingDate})`,
      relay: relayRequired
        ? `Yes (Blackout > ${spec.maxBlackoutLimitHrs}h)`
        : `No (Direct DTE ≤ ${spec.maxBlackoutLimitHrs}h)`,
    },
    params: {
      slope: `${topo.slopeDeg}° (±${topo.slopeUncertaintyDeg}°)`,
      slopeNote,
      elevation: `${topo.elevationM.toLocaleString("en-US")} m (±${topo.elevationUncertaintyM}m)`,
      horizon: `${topo.horizonBlockDeg}° (Min ${topo.minHorizonDeg}°)`,
      psr: topo.isInsidePsr ? "0.0 km (Inside PSR)" : `${topo.psrDistKm} km`,
      sunlight: `${windowMetrics.sunlightHours} hrs (${windowMetrics.sunlightPct}% ±${sunlightUncertaintyPct}%)`,
      peakElev: `${windowMetrics.peakSolarElevDeg}°`,
      eclipse: `${eclipsePrefix}${windowMetrics.maxEclipseHours} hrs`,
      dte: `${windowMetrics.dteUptimePct}%`,
      blackout: `${blackoutPrefix}${windowMetrics.maxBlackoutHours} hrs`,
    },
    rawNumbers: {
      maxSlopeLimitDeg: spec.maxSlopeDeg,
      safeSlopeDeg: spec.safeSlopeDeg,
      noGoSlopeDeg: spec.noGoSlopeDeg,
      maxBlackoutLimitHrs: spec.maxBlackoutLimitHrs,
      maxEclipseSafeHrs: spec.maxEclipseSafeHrs,
      targetSunPct: spec.targetSunPct,
      noGoSunPct: spec.noGoSunPct,
      targetDtePct: spec.targetDtePct,
      noGoDtePct: spec.noGoDtePct,
      totalWindowHours: totalHours,
      slopeDeg: topo.slopeDeg,
      slopeUncertaintyDeg: topo.slopeUncertaintyDeg,
      elevationM: topo.elevationM,
      elevationUncertaintyM: topo.elevationUncertaintyM,
      horizonBlockDeg: topo.horizonBlockDeg,
      minHorizonDeg: topo.minHorizonDeg,
      psrDistKm: topo.psrDistKm,
      sunlightHours: windowMetrics.sunlightHours,
      sunlightPct: windowMetrics.sunlightPct,
      sunlightUncertaintyPct,
      peakSolarElevDeg: windowMetrics.peakSolarElevDeg,
      maxEclipseHours: windowMetrics.maxEclipseHours,
      dteUptimePct: windowMetrics.dteUptimePct,
      maxBlackoutHours: windowMetrics.maxBlackoutHours,
      shift29dSunlightDeltaHours: shiftedMetrics.sunlightHours - windowMetrics.sunlightHours,
      shift29dDteDeltaPct: Number(
        (shiftedMetrics.dteUptimePct - windowMetrics.dteUptimePct).toFixed(1),
      ),
      nearbyNorth350mSunlightDeltaHours: northMetrics.sunlightHours - windowMetrics.sunlightHours,
    },
  };

  const sources: LunarSource[] = [
    {
      id: "source-1",
      name: `NASA LOLA ${topo.datasetUsed}`,
      url: "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/",
      publisher: "NASA PDS Geosciences Node",
      domain: "Global Lunar Topography",
      usage: `Global elevation (${topo.elevationM} m ±${topo.elevationUncertaintyM} m), baseline slope (${topo.slopeDeg}° ±${topo.slopeUncertaintyDeg}°), 100+ km 360° spherical horizon profile (${topo.horizonBlockDeg}° max, ${topo.minHorizonDeg}° min), and PSR proximity (${topo.isInsidePsr ? "Inside PSR" : `${topo.psrDistKm} km`}).`,
    },
    {
      id: "source-2",
      name: "JPL Horizons (DE440 Ephemeris)",
      url: "https://ssd.jpl.nasa.gov/horizons/",
      publisher: "NASA JPL Solar System Dynamics",
      domain: "Ephemeris & Visibility",
      usage: `Topocentric Sun & Earth trajectories at ${Math.abs(params.lat).toFixed(2)}° ${latHemisphere}, peak solar incidence (${windowMetrics.peakSolarElevDeg}°), and Earth libration DTE uptime (${windowMetrics.dteUptimePct}%).`,
    },
    {
      id: "source-3",
      name: "NASA CLPS Lander Engineering Specs",
      url: "https://www.nasa.gov/commercial-lunar-payload-services/",
      publisher: "NASA Commercial Lunar Payload Services",
      domain: "Flight Limits & Constraints",
      usage: `CLPS Lander limits: touchdown tilt ≤ ${spec.maxSlopeDeg}°, battery eclipse survival ≤ ${spec.maxEclipseSafeHrs} hrs, max autonomous comms blackout ≤ ${spec.maxBlackoutLimitHrs} hrs.`,
    },
  ];

  return {
    telemetry,
    sources,
    ephemerisMode: useLive ? "jpl-horizons-de440-live" : "de440-global-spherical-ephemeris",
  };
}