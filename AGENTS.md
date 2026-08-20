# For the agent installing dsh-verifier

You are adding this plugin to an existing DeepSeek Harness installation. Finish when the smoke tests in step 4 pass.

## Steps

1. **Find the harness and its home.** `dsh` is either a source checkout (run as `pnpm dsh` inside it, or through a launcher) or an installed command. The home is `$DSH_HOME`, default `~/.dsh`; profiles live in `$DSH_HOME/profiles/<name>`. Done when you can run `dsh --profile headless --dump-config` (or the `pnpm dsh` equivalent) without error.

2. **Point the plugin at a verifier endpoint.** The plugin scores with an OpenAI-compatible chat-completions endpoint that returns `logprobs`. Ask the human for `baseURL`, model id and (if any) the API key variable, then write them as a `verifier:` section in `$DSH_HOME/settings.yaml`:
   ```yaml
   verifier:
     backend:
       baseURL: http://<host>:8000/v1
       model: <model id>
       apiKeyEnv: <ENV_VAR or empty>
       reasoningEffort: none
   ```
   `cordis.patch.yml` in this repo holds the rest of the defaults. Done when the section is in the file and `curl <baseURL>/models` answers.

3. **Install the plugin and link the skill.** Run, per profile the human uses (`web`, `headless`, `desktop`):
   ```sh
   dsh plugin --profile <p> add /absolute/path/to/dsh-verifier
   ```
   Then link the skill so dsh can load it:
   ```sh
   mkdir -p $DSH_HOME/skills
   ln -sfn /absolute/path/to/dsh-verifier/skills/graph-verified-coding $DSH_HOME/skills/graph-verified-coding
   ```
   `lib/` is committed; no build is needed. Restart a running `dsh web` or DSH Desktop afterwards. Done when `dsh --profile <p> --dump-config` shows a `# == dsh-verifier` layer with the `verifier` row, and `$DSH_HOME/skills/graph-verified-coding/SKILL.md` resolves.

4. **Smoke tests.** Read the answers, do not infer them:
   - `dsh --profile headless "Answer in one word: ok"` finishes; with `verifier: verbose: true` in settings the host log shows `dsh-verifier: ... PASSED` or `BELOW threshold`.
   - `dsh --profile headless "Use verifier_select with task='What is 12*12?' and candidates ['144','124'] and return bestIndex."` answers 0.
   - `dsh --profile headless "Load the skill graph-verified-coding and reply only with the number of steps."` answers 7.
   - `dsh --profile headless "Call ui_snapshot with url https://example.com/ and reply only with the number of shots and the browser field."` answers 4 and a `headless=true` browser (needs Google Chrome or a Playwright Chromium on the machine).
   Done when all four hold.

5. **Report.** The profiles touched, the `verifier:` section written, the three smoke-test outputs verbatim. Done when the human can reproduce every claim.

## Reference

**Settings.** Everything under `verifier:` in `$DSH_HOME/settings.yaml` hot-reloads. `gate.threshold` (0.6), `gate.maxRounds` (1), `gate.enabled`, `tools`, `backend.reasoningEffort`. The README lists every key.

**Cost.** One gate pass is three verifier calls at the end of every turn. Tell the human that, and how to turn it off (`verifier: gate: enabled: false`).

**Logs.** `dsh web` prints the harness logger to its terminal; DSH Desktop writes `~/Library/Application Support/DSH Desktop/logs/dsh-<date>.log`. Headless keeps stderr empty on success.

**Development only.** Typechecking needs a harness checkout at `../deepseek-harness` (the `link:` devDependencies). Installing does not.
