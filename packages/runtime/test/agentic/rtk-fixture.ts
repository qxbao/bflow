import { execFile } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { promisify } from "node:util";

/** Seatbelt grants the exact executable only. Use a native test CLI on macOS, rather than granting
 * /bin/sh and cat merely so Linux shell-script fixtures can run in the production sandbox. */
export async function writeDarwinRtkFixture(path: string, mode: "passthrough" | "count" | "fail-test-output"): Promise<void> {
  if (process.platform !== "darwin") return;
  const source = path + ".c";
  await writeFile(source, `
#include <stdio.h>
#include <string.h>
int main(int argc,char **argv) {
  if(argc==2 && !strcmp(argv[1],"--version")){puts("rtk 1.0.1");return 0;}
  if(argc==3 && !strcmp(argv[1],"pipe") && !strcmp(argv[2],"--help")){puts("Read stdin --filter <FILTER>");return 0;}
  if(argc<2 || strcmp(argv[1],"pipe")) return 2;
  char bytes[1048576];size_t length=fread(bytes,1,sizeof(bytes)-1,stdin);bytes[length]=0;
  ${mode === "passthrough" ? "return fwrite(bytes,1,length,stdout)==length?0:2;" : mode === "fail-test-output"
    ? 'if(strstr(bytes,"not ok"))return 2;puts("filtered probe");return 0;'
    : 'int lines=0;for(size_t i=0;i<length;i++)if(bytes[i]==10)lines++;printf("filtered:%d lines\\n",lines);return 0;'}
}
`, { mode: 0o600 });
  try { await promisify(execFile)("/usr/bin/clang", ["-Wall", "-Werror", source, "-o", path], { timeout: 30_000, env: { PATH: "/usr/bin:/bin" } }); }
  finally { await rm(source, { force: true }); }
}
