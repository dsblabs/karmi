import { defineAgent, defineFragment, type MediaRef, type Thread } from "@karmi/core";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { decodeSample, sampleData } from "./sample-data";

/** The id of the container Scripts scenario. It is also the id of its Agent. */
export const CONTAINERS = "container-scripts";

/** Where container Scripts run: in Docker through `pnpm dev:containers`, or in Cloudflare Containers. */
export type ContainerRuntime = "docker" | "cloudflare";

/** Reads the `PLAYGROUND_CONTAINERS` variable. Each other value gives no container runtime. */
export function containerRuntime(value: string | undefined): ContainerRuntime | undefined {
  return value === "docker" || value === "cloudflare" ? value : undefined;
}

/**
 * The image of the container sandbox, as `wrangler.jsonc` names it. It is the Dockerfile of
 * `@karmi/sandbox-container`, thus the Playground runs the image that the Framework supplies.
 */
export const CONTAINER_IMAGE = "./node_modules/@karmi/sandbox-container/Dockerfile";

/**
 * The container limits of the Agent. A process becomes a Job after 5 seconds, thus the long Script shows a Job
 * soon. The other limits are the defaults, except the count of artifacts.
 */
export const CONTAINER_LIMITS = { wallMs: 5000, jobMaxWallMs: 120_000, idleMs: 60_000, maxArtifacts: 5 };

/** The hostnames that a container Script can reach. Each other hostname is denied. */
export const EGRESS_ALLOW = ["example.com"];

/** One sample input file. Each Thread of the scenario gets its own copy as Thread media. */
export interface SampleFile {
  name: string;
  mimeType: string;
  text: string;
}

/** The sample input files, in the order that the page shows them. */
export const SAMPLE_FILES: readonly SampleFile[] = [
  {
    name: "sales.csv",
    mimeType: "text/csv",
    text: `region,product,units,unit_price
North,Kettle,12,25
North,Toaster,5,40
South,Kettle,8,25
South,Blender,3,60
East,Toaster,9,40
East,Blender,4,60
West,Kettle,15,25
`,
  },
  {
    name: "returns.csv",
    mimeType: "text/csv",
    text: `region,product,units
North,Toaster,1
East,Blender,2
`,
  },
];

const mediaRefSchema = z.object({
  id: z.string(),
  key: z.string(),
  mimeType: z.string(),
  bytes: z.number(),
  name: z.string().optional(),
});

const storedSchema = z.object({ files: z.record(z.string(), mediaRefSchema) });

/** Reads the refs of the sample files of the current Thread. Returns undefined before the Thread has them. */
export function decodeSampleFiles(data: string | undefined): Record<string, MediaRef> | undefined {
  return decodeSample(storedSchema.optional(), undefined, data)?.files;
}

/**
 * Returns the sample files of the Thread. The first call uploads them as Thread media and stores their refs. A
 * reset deletes the Thread with its media and the stored refs, thus the next Thread gets new copies.
 */
export async function sampleFilesOf(
  scope: string,
  stored: string | undefined,
  thread: Thread,
): Promise<Record<string, MediaRef>> {
  const known = decodeSampleFiles(stored);
  if (known) return known;
  const files: Record<string, MediaRef> = {};
  for (const file of SAMPLE_FILES)
    files[file.name] = await thread.uploads.put(file.text, { name: file.name, mimeType: file.mimeType });
  await sampleData(env.PLAYGROUND_DATA, scope, CONTAINERS).write(JSON.stringify({ files }));
  return files;
}

/**
 * Gives the model the refs of the sample files. A container Script gets a file only when the `files` input of
 * `run_script` names its ref, and the model cannot know a ref without this Fragment.
 */
export const sampleFiles = defineFragment({
  name: "sample_files",
  description: "The media refs of the sample input files of the Thread.",
  async render(ctx) {
    const files = decodeSampleFiles((await sampleData(env.PLAYGROUND_DATA, ctx.scope, CONTAINERS).read()).data);
    if (!files) return null;
    return `The sample files of this Thread. To give them to a Script, put this object as it is in the files input of run_script. The Script then reads each file in /in.\n\n\`\`\`json\n${JSON.stringify(files)}\n\`\`\``;
  },
});

/** Defines the Agent of the container Scripts scenario for the model that setup selected. */
export const containerAgent = (model: string) =>
  defineAgent({
    agentId: CONTAINERS,
    name: "Data desk",
    instructions: [
      {
        text: "You work at the data desk of a small shop. When the operator gives you a shell or Python script, call run_script one time with the code as written and its language. Do not change the code. Then tell the result or the error in one or two sentences, and name each file that the script wrote.",
      },
      { fragment: "sample_files" },
    ],
    model: { id: model },
    policy: [{ match: { tool: "run_script" }, effect: "allow" }],
    capabilities: {
      scripts: { tier: "container", limits: CONTAINER_LIMITS, egress: { allow: EGRESS_ALLOW } },
    },
  });

const script = (language: "python" | "shell", code: string, files = true) =>
  `Run this ${language} script with run_script. ${files ? "Pass the sample files." : "Pass no files."} Do not change the code.\n\n\`\`\`${language === "python" ? "python" : "sh"}\n${code}\n\`\`\``;

/** The prompts that the scenario suggests. Each one has the Script that the model runs. The operator can edit each one. */
export const CONTAINER_PROMPTS = [
  {
    label: "Python report",
    text: script(
      "python",
      `import csv
from collections import defaultdict

prices = {}
revenue = defaultdict(int)
with open("/in/sales.csv") as sales:
    for row in csv.DictReader(sales):
        prices[row["product"]] = int(row["unit_price"])
        revenue[row["region"]] += int(row["units"]) * int(row["unit_price"])
with open("/in/returns.csv") as returns:
    for row in csv.DictReader(returns):
        revenue[row["region"]] -= int(row["units"]) * prices[row["product"]]

with open("/out/revenue.csv", "w", newline="") as out:
    writer = csv.writer(out)
    writer.writerow(["region", "net_revenue"])
    for region, total in sorted(revenue.items()):
        writer.writerow([region, total])
with open("/out/report.md", "w") as out:
    out.write("# Net revenue by region\\n\\n")
    for region, total in sorted(revenue.items()):
        out.write(f"- {region}: {total}\\n")
print(f"Wrote 2 files for {len(revenue)} regions. Net revenue: {sum(revenue.values())}")`,
    ),
  },
  {
    label: "Shell summary",
    text: script(
      "shell",
      `echo "Lines in each file:"
wc -l /in/sales.csv /in/returns.csv
tail -n +2 /in/sales.csv | cut -d, -f2 | sort | uniq -c | sort -rn > /out/products.txt
echo "Sales rows for each product:"
cat /out/products.txt`,
    ),
  },
  {
    label: "Long process",
    text: script(
      "shell",
      `for step in $(seq 1 40); do
  echo "Step $step of 40"
  sleep 1
done
echo "Finished 40 steps" > /out/long-run.txt
echo "Done"`,
      false,
    ),
  },
  {
    label: "Allowed host",
    text: script(
      "shell",
      `curl -sS -o /dev/null -w "example.com answered HTTP %{http_code}\\n" https://example.com`,
      false,
    ),
  },
  {
    label: "Denied host",
    text: script(
      "shell",
      `curl -sS -o /dev/null -w "example.org answered HTTP %{http_code}\\n" https://example.org`,
      false,
    ),
  },
];
