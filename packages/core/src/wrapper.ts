import fs from "node:fs";
import path from "node:path";

export interface RepositoryWrapperStatus {
  path: string;
  exists: boolean;
  isRegularFile: boolean;
  isReadable: boolean;
  isExecutable: boolean;
  isUsable: boolean;
}

export function inspectRepositoryWrapper(repoRoot: string): RepositoryWrapperStatus {
  const wrapperPath = path.join(repoRoot, "bin/memory");

  if (!fs.existsSync(wrapperPath)) {
    return {
      path: wrapperPath,
      exists: false,
      isRegularFile: false,
      isReadable: false,
      isExecutable: false,
      isUsable: false
    };
  }

  let isRegularFile = false;

  try {
    isRegularFile = fs.statSync(wrapperPath).isFile();
  } catch {
    return {
      path: wrapperPath,
      exists: true,
      isRegularFile: false,
      isReadable: false,
      isExecutable: false,
      isUsable: false
    };
  }

  if (!isRegularFile) {
    return {
      path: wrapperPath,
      exists: true,
      isRegularFile: false,
      isReadable: false,
      isExecutable: false,
      isUsable: false
    };
  }

  const isReadable = hasAccess(wrapperPath, fs.constants.R_OK);
  const isExecutable = hasAccess(wrapperPath, fs.constants.X_OK);

  return {
    path: wrapperPath,
    exists: true,
    isRegularFile: true,
    isReadable,
    isExecutable,
    isUsable: isReadable && isExecutable
  };
}

export function tryReadRepositoryWrapper(status: RepositoryWrapperStatus): string | null {
  if (!status.isRegularFile || !status.isReadable) {
    return null;
  }

  try {
    return fs.readFileSync(status.path, "utf8");
  } catch {
    return null;
  }
}

function hasAccess(targetPath: string, mode: number): boolean {
  try {
    fs.accessSync(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}
