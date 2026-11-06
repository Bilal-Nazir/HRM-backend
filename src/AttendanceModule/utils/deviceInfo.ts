import { isIP } from "node:net";
import type { Request } from "express";

const text = (value: unknown, max = 100): string | undefined => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) || undefined : undefined;
const number = (value: unknown, max: number): number | undefined => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max ? value : undefined;
const ip = (value: unknown) => { const clean = text(value); return clean && isIP(clean) ? clean : undefined; };

// Headers and client hints describe the request, not a verified hardware identity.
// Never accept network addresses, hardware identifiers or capture times from the body.
export function attendanceDeviceInfo(req: Pick<Request, "headers" | "ip" | "socket" | "body">, at = new Date()) {
  const ua = text(req.headers["user-agent"], 1024) || "";
  const input = req.body?.device;
  const client = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const browsers: [string, RegExp][] = [["Edge", /Edg(?:e|A|iOS)?\/([\d.]+)/], ["Opera", /(?:OPR|OPiOS)\/([\d.]+)/], ["Samsung Internet", /SamsungBrowser\/([\d.]+)/], ["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/], ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/], ["Safari", /Version\/([\d.]+).*Safari/]];
  const browserMatch = browsers.map(([name, pattern]) => ({ name, match: ua.match(pattern) })).find((item) => item.match);
  let os = "Unknown", osVersion: string | undefined;
  if (/Windows NT/.test(ua)) { os = "Windows"; osVersion = ua.match(/Windows NT ([\d.]+)/)?.[1]; }
  else if (/Android/.test(ua)) { os = "Android"; osVersion = ua.match(/Android ([\d.]+)/)?.[1]; }
  else if (/iPhone|iPad|iPod/.test(ua) || /Macintosh/.test(ua) && Number(client.touchPoints) > 1) { os = /iPad|Macintosh/.test(ua) ? "iPadOS" : "iOS"; osVersion = ua.match(/(?:CPU (?:iPhone )?OS|iPhone OS) ([\d_]+)/)?.[1]?.replaceAll("_", "."); }
  else if (/Mac OS X/.test(ua)) { os = "macOS"; osVersion = ua.match(/Mac OS X ([\d_]+)/)?.[1]?.replaceAll("_", "."); }
  else if (/CrOS/.test(ua)) { os = "ChromeOS"; osVersion = ua.match(/CrOS \S+ ([\d.]+)/)?.[1]; }
  else if (/Linux/.test(ua)) os = "Linux";
  let deviceType: "desktop" | "mobile" | "tablet" | "unknown" = !ua ? "unknown" : /iPad|Tablet|PlayBook|Silk/i.test(ua) || os === "iPadOS" || /Android/.test(ua) && !/Mobile/.test(ua) ? "tablet" : /Mobi|iPhone|iPod|Windows Phone/i.test(ua) ? "mobile" : /Windows|Macintosh|Linux|CrOS/.test(ua) ? "desktop" : "unknown";
  if (deviceType === "unknown" && client.mobile === true) deviceType = "mobile";
  const platform = text(client.platform, 60);
  // Keep the hint version separate: its numbering can differ from the OS marketing version.
  const platformVersion = text(client.platformVersion, 60);
  return {
    capturedAt: at, deviceType, browser: browserMatch?.name || "Unknown", browserVersion: browserMatch?.match?.[1], os, osVersion,
    userAgent: ua || undefined, ipAddress: ip(req.ip), connectionIp: ip(req.socket?.remoteAddress),
    platform, platformVersion, model: text(client.model), architecture: text(client.architecture, 30), bitness: ["32", "64"].includes(client.bitness) ? client.bitness : undefined,
    timezone: text(client.timezone, 100), language: text(client.language, 35),
    screenWidth: number(client.screenWidth, 32768), screenHeight: number(client.screenHeight, 32768),
    viewportWidth: number(client.viewportWidth, 32768), viewportHeight: number(client.viewportHeight, 32768), pixelRatio: number(client.pixelRatio, 16),
    touchPoints: typeof client.touchPoints === "number" && Number.isInteger(client.touchPoints) && client.touchPoints >= 0 && client.touchPoints <= 32 ? client.touchPoints : undefined,
    logicalProcessors: number(client.logicalProcessors, 1024), memoryGB: number(client.memoryGB, 1024),
  };
}
