// Prints the machine and software the benchmarks ran on. Every results file starts with this,
// because a number without its environment cannot be compared with anything.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";

const run = (command: string, args: string[], cwd?: string) => {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"], cwd }).replace(/\0/g, "").trim();
  } catch {
    return "";
  }
};
const first = (text: string) => text.split("\n")[0]?.trim() ?? "";

export function environment() {
  const cpus = os.cpus();
  const osRelease = (() => {
    try {
      return /PRETTY_NAME="([^"]+)"/.exec(readFileSync("/etc/os-release", "utf8"))?.[1] ?? "";
    } catch {
      return "";
    }
  })();
  const containers = run("docker", ["ps", "--format", "{{.Names}} ({{.Image}})"]).split("\n").filter(Boolean);
  const dockerStats = run("docker", ["stats", "--no-stream", "--format", "{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}"]).split("\n").filter(Boolean);
  return {
    date: new Date().toISOString(),
    cpu: cpus[0]?.model.trim() ?? "unknown",
    logicalCores: cpus.length,
    ramGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    os: osRelease || os.type(),
    kernel: os.release(),
    wsl: first(run("wsl.exe", ["--version"], "/mnt/c")) || "not WSL, or wsl.exe not reachable",
    node: process.version,
    postgres: first(run("docker", ["exec", "flagforge-postgres", "psql", "-U", "flagforge", "-d", "flagforge", "-Atc", "show server_version"])) || "not reachable",
    redis: /redis_version:(\S+)/.exec(run("docker", ["exec", "flagforge-redis", "redis-cli", "info", "server"]))?.[1] ?? "not reachable",
    loadAverage1m5m15m: os.loadavg().map((n) => Math.round(n * 100) / 100),
    freeRamGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
    // "Was Docker under other load?" Answered by listing what was running and how busy it was.
    runningContainers: containers,
    containerLoad: dockerStats,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(environment(), null, 2));
