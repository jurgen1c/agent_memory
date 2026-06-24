import { compileMemory, type CompileResult } from "./compiler";
import { doctorMemory, type DoctorResult } from "./doctor";
import { validateRepository, type ValidationResult } from "./validator";

export interface SyncOptions {
  cwd?: string;
}

export interface SyncResult {
  compile: CompileResult;
  validation: ValidationResult;
  doctor: DoctorResult;
}

export async function syncMemory(options: SyncOptions = {}): Promise<SyncResult> {
  const compile = await compileMemory({ cwd: options.cwd });
  const validation = validateRepository({ cwd: options.cwd });
  const doctor = await doctorMemory({ cwd: options.cwd });

  return {
    compile,
    validation,
    doctor
  };
}
