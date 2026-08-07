const os = require('os');
const systemInformation = require('systeminformation');

function megabytesToBytes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 1024 ** 2) : 0;
}

function createHardwareProfile({
  getEndpoint,
  isLocalEndpoint,
  processRef = process,
  osRef = os,
  systemInformationRef = systemInformation,
  cacheMs = 60_000,
} = {}) {
  let cached = null;
  let cachedAt = 0;

  return async function hardwareProfile() {
    if (cached && Date.now() - cachedAt < cacheMs) {
      return { ...cached, appliesToEndpoint: isLocalEndpoint(getEndpoint()) };
    }

    let memory = {};
    try {
      memory = typeof processRef.getSystemMemoryInfo === 'function' ? processRef.getSystemMemoryInfo() : {};
    } catch {}

    let graphics = { controllers: [] };
    try { graphics = await systemInformationRef.graphics(); } catch {}
    const controllers = (graphics.controllers || []).map((controller) => ({
      vendor: controller.vendor || null,
      model: controller.model || controller.name || null,
      vramBytes: megabytesToBytes(controller.memoryTotal || controller.vram),
      freeVramBytes: megabytesToBytes(controller.memoryFree),
      dynamic: !!controller.vramDynamic,
      cores: controller.cores || null,
      external: !!controller.external,
    }));
    const unifiedMemory = processRef.platform === 'darwin' && processRef.arch === 'arm64';
    const dedicatedControllers = controllers.filter((controller) => !controller.dynamic && controller.vramBytes > 0);
    const totalMemoryBytes = Number(memory.total) > 0 ? Number(memory.total) * 1024 : osRef.totalmem();
    const freeMemoryKiB = Number.isFinite(Number(memory.free)) ? Number(memory.free) : 0;
    const purgeableMemoryKiB = Number.isFinite(Number(memory.purgeable)) ? Number(memory.purgeable) : 0;

    cached = {
      platform: processRef.platform,
      arch: processRef.arch,
      cpu: osRef.cpus()?.[0]?.model || null,
      totalMemoryBytes,
      availableMemoryBytes: (freeMemoryKiB + purgeableMemoryKiB) * 1024,
      unifiedMemory,
      controllers,
      totalVramBytes: dedicatedControllers.reduce((sum, controller) => sum + controller.vramBytes, 0),
      freeVramBytes: dedicatedControllers.reduce((sum, controller) => sum + controller.freeVramBytes, 0),
      appliesToEndpoint: isLocalEndpoint(getEndpoint()),
    };
    cachedAt = Date.now();
    return cached;
  };
}

module.exports = { createHardwareProfile, megabytesToBytes };
