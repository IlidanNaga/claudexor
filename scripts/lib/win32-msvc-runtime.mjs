const DEPENDENCY_BASENAME = /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*\.dll)\s*$/gim;
const DYNAMIC_CRT_BASENAME =
  /^(?:(?:vcruntime|msvcp|msvcr|concrt|vcomp|vccorlib)[a-z0-9_.-]*|ucrtbase(?:d)?|api-ms-win-crt-[a-z0-9_.-]+)\.dll$/i;

export function sanitizedMsvcEnvironment(environment) {
  const sanitized = { ...environment };
  for (const key of Object.keys(sanitized)) {
    const normalized = key.toUpperCase();
    if (normalized === "CL" || normalized === "_CL_") delete sanitized[key];
  }
  return sanitized;
}

export function dumpbinDependencyBasenames(output) {
  return [...String(output).matchAll(DEPENDENCY_BASENAME)].map((match) => match[1]);
}

export function dynamicCrtDependencies(dependencies) {
  return dependencies.filter((dependency) => DYNAMIC_CRT_BASENAME.test(dependency));
}
