# Dynamic Worker CPU limits

The probe ran on 2026-09-25 on the Workers Paid plan, with compatibility date `2026-08-04` and wrangler 4.129.0. It used a temporary Worker that ran a busy loop in a Dynamic Worker through a `worker_loaders` binding. The probe ran each case from a Worker and from a Durable Object. Issue [#228](https://github.com/dsblabs/karmi/issues/228) asked why the `cpuMs` limit of an isolate Script did not stop a Script.

## Method

The loop is `for (let step = 0; step < n; step++) sum += step % 7;`. To calibrate the loop, the probe ran it directly in the Worker, and `wrangler tail` reported the `cpuTime` of each request:

| Steps | CPU time |
| --- | --- |
| 100,000,000 | 244 ms |
| 300,000,000 | 710 ms |
| 600,000,000 | 1,598 ms |
| 1,000,000,000 | 3,616 ms |

Thus one million steps use about 2.4 to 3.6 ms of CPU time. `Date.now()` does not advance while a Worker computes, thus the probe could not measure the time inside the loop.

The probe tested each combination of these options:

- `LOADER.load()` or `LOADER.get()`.
- An RPC call to a method of the entrypoint, or `fetch`.
- `limits` in the Worker code, `limits` in `getEntrypoint()`, or no limits.
- The loop in the method, or at the top level of the module.

## Results

At 300,000,000 steps and `cpuMs: 50`, each of the 48 cases finished with no error, from a Worker and from a Durable Object. The options above did not change the result.

The next table has the RPC case with `load()` and `limits` in the Worker code, from a Durable Object. The CPU times come from the calibration.

| `cpuMs` | The Script finished at | Cloudflare stopped the Script at |
| --- | --- | --- |
| 10 | 800,000,000 steps, about 2.9 s | 1,000,000,000 steps, about 3.6 s |
| 50 | 1,000,000,000 steps, about 3.6 s | 1,600,000,000 steps, about 5.5 s |
| 2,000 | 1,000,000,000 steps, about 3.6 s | 1,600,000,000 steps, about 5.5 s |
| 5,000 | 1,200,000,000 steps, about 4.3 s | 1,600,000,000 steps, about 5.5 s |
| 10,000 | 1,600,000,000 steps, about 5.5 s | 2,400,000,000 steps, about 8.6 s |
| not set | 2,400,000,000 steps, about 8.6 s | 4,800,000,000 steps, about 17 s |

At 3,000,000,000 steps and `cpuMs: 10`, Cloudflare stopped the Script in the RPC case with `load()`, from a Worker and from a Durable Object. The error message was `Worker exceeded CPU time limit.` for a loop in a method. It was `Script startup exceeded CPU time limit.` for a loop at the top level of the module.

A second probe raced the RPC call against a 300 ms `setTimeout` in the caller. The loop had 1,000,000,000 steps and no limit. The RPC call won each time. Thus the timer of the caller did not fire until the loop finished.

## Conclusions

- Cloudflare enforces `cpuMs` on an RPC call to a Dynamic Worker. No plan setting or compatibility flag is necessary.
- The stop is coarse. A limit below about 3 seconds acts as a limit of about 3 to 5 seconds of CPU time.
- `CloudflareIsolateSandbox` maps both error messages to `limit_exceeded: cpuMs`.
- The Dynamic Worker runs on the thread of the caller. A `wallMs` timer or a cancel in the caller acts only when the Script awaits.
