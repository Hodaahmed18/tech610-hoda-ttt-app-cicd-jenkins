# 3-Job CI/CD Pipeline, deploying the Tic Tac Toe app with Jenkins

## Why we set the pipeline up this way

The whole point of this pipeline is to remove manual steps between a developer making a change and that change safely reaching production, while never letting untested or unmerged code anywhere near the live app.

Splitting it into three separate jobs, rather than one big script, gives each stage its own clear gate:
- Job 1 proves the code actually works before anything else happens
- Job 2 only merges the change into the main codebase if Job 1 passed
- Job 3 only deploys to the real server if Job 2's merge succeeded

Each job depends entirely on the one before it succeeding. If a change breaks a test, it never gets merged, and if it never gets merged, it never gets deployed. That is the actual business value, developers can push changes constantly without fear of a broken change reaching real users, since the pipeline itself enforces the safety checks that used to depend on someone remembering to test and check manually before deploying.

## Diagram

```
Developer pushes to dev branch
            |
            v
      GitHub repo
            |
    (webhook fires)
            v
   +-----------------+
   |      Jenkins     |
   |  (master node,   |
   |  uses agent node |
   |  to run jobs)    |
   +-----------------+
            |
            v
Job 1: test code on dev branch
   (cd app, npm ci, npm test)
            |
     if successful
            v
Job 2: merge dev into master
   (Merge before build, then
    re-run tests, then Git
    Publisher pushes the
    merge only if build
    succeeds)
            |
     if successful
            v
Job 3: deploy to EC2
   (scp the tested code across,
    ssh in, npm ci, restart
    the app with pm2)
            |
            v
   Live app updated on EC2
```

## How each job was actually set up

### Job 1, `hoda-ttt-job1-ci-test`

**Purpose:** test whatever was just pushed to the `dev` branch, before anything else happens.

**Source Code Management:**
- Repository URL (SSH format): `git@github.com:Hodaahmed18/tech610-hoda-ttt-app-cicd-jenkins.git`
- Credentials: `jenkins (hoda-jenkins-2-gh-ttt-app)`, an SSH key added as a GitHub deploy key on the repo, with write access enabled
- Branch Specifier: `*/dev`

**Build Triggers:**
- GitHub hook trigger for GITScm polling, ticked. This means a webhook on the GitHub repo notifies Jenkins the instant a push happens, rather than Jenkins checking on a timer

**Build Environment:**
- Provide Node & npm bin/ folder to PATH, NodeJS version 20 selected, so `npm` commands are available in the shell step

**Build Steps, Execute shell:**
```bash
cd app
npm ci
npm test
```
`npm ci` does a clean install using the exact versions locked in `package-lock.json`, more reliable for a pipeline than `npm install`, since it never silently updates the lock file itself. `npm test` runs whatever test script is defined in `package.json`.

**Post-build Actions:**
- Build other projects, Projects to build: `hoda-ttt-job2-ci-merge`, Trigger only if build is stable, ticked

This last part is the actual gate. If `npm test` fails, the build is not stable, and Job 2 never fires at all.

### Job 2, `hoda-ttt-job2-ci-merge`

**Purpose:** merge the tested `dev` branch into `master`, but only push that merge if the code still passes its tests once merged.

**Source Code Management:**
- Same repository URL and credentials as Job 1
- Branch Specifier: `*/dev`

**Additional Behaviours:**
- Merge before build, ticked. Name of repository: `origin`. Branch to merge to: `master`. This checks out `dev`, then merges it into `master` locally, inside Jenkins' own workspace, before any build step runs at all

**Build Triggers:**
- Nothing ticked here. Job 2 never listens for a webhook or polling directly, it only ever runs because Job 1's post-build action told it to

**Build Steps, Execute shell:**
```bash
cd app
npm ci
npm test
```
Same as Job 1, but now this is testing the merged result of dev and master together, not dev in isolation, a genuine check that the merge itself did not break anything.

**Post-build Actions:**
- Git Publisher, ticked
  - Push Only If Build Succeeds, ticked. This is the real gate for this job, if the merged code fails its tests, the merge is discarded and never pushed to GitHub at all
  - Merge Results, ticked (pushes the pre-build merge result back to origin)
  - Branch to push: `master`, Target remote name: `origin`
- Build other projects, Projects to build: `hoda-ttt-job3-cd-deploy`, Trigger only if build is stable, ticked

**A note on an alternative approach:** the merge can also be done with plain shell commands instead of the Git Publisher plugin, for example:
```bash
git checkout main
git status
git merge origin/dev
git push --set-upstream origin main
```
This achieves the same result, checking out the target branch, merging the source branch into it, then pushing, but does it explicitly in the shell rather than relying on Jenkins' built in Git plugin features. The tradeoff is this manual version does not automatically gate the push behind test success unless the push command is itself placed after the test step and made conditional on it succeeding, whereas Git Publisher's "Push Only If Build Succeeds" handles that gate natively.

### Job 3, `hoda-ttt-job3-cd-deploy`

**Purpose:** copy the tested, merged code from Jenkins onto the actual EC2 instance running the app, then restart the app so the change goes live.

**Source Code Management:**
- Same repository URL as Jobs 1 and 2
- Credentials: `jenkins (hoda-jenkins-2-gh-ttt-app)`, same GitHub key, used here only to check out the code, not to push anything
- Branch Specifier: `*/master`. Deliberately not `dev`, since by the time Job 3 runs, `master` is the single source of truth for what has actually passed both the test gate and the merge gate

**Build Triggers:**
- Nothing ticked, same reasoning as Job 2, this only ever runs because Job 2's post-build action triggered it

**Build Environment:**
- SSH Agent, ticked, with the EC2 SSH credential selected (added separately as a Jenkins credential, kind: SSH Username with private key, using the `.pem` file for the EC2 instance)

**Build Steps, Execute shell:**
```bash
scp -o StrictHostKeyChecking=no -r app/* ubuntu@<EC2_PUBLIC_IP>:/home/ubuntu/app/app/
ssh -o StrictHostKeyChecking=no ubuntu@<EC2_PUBLIC_IP> "cd /home/ubuntu/app/app && npm ci && (pm2 restart index || pm2 start index.js)"
```
The task specifically requires using `scp` or `rsync` to copy code across, not a `git clone` directly onto the production instance. `scp -r app/*` copies the tested code from the Jenkins workspace over to the instance's actual app directory. The `ssh` command that follows logs into the instance, installs the exact dependencies fresh, then restarts the running app process with pm2, falling back to starting it if it was not already running.

## Authentication and security, summary

Two entirely separate credentials are involved, each for a different purpose:
- **GitHub SSH key** (`jenkins (hoda-jenkins-2-gh-ttt-app)`), used by Jobs 1, 2, and 3 to check out code, and by Job 2 specifically to push the merge back. Added as a Deploy Key on the GitHub repository itself, with write access enabled, since Job 2 needs to push
- **EC2 SSH key** (`hoda-ubuntu`), used only by Job 3, via the SSH Agent build environment option, to authenticate onto the actual application server and run commands there

The EC2 instance's security group currently allows SSH from anywhere and port 3000 from anywhere, to get the pipeline working initially. A tighter setup would scope SSH access specifically to the Jenkins worker node's own security group or IP, rather than the whole internet.

## A real bug hit while building this

An accidental infinite loop was created when Job 2's post-build "Build other projects" field was mistakenly set to trigger itself, rather than Job 3. Every successful run of Job 2 triggered another run of Job 2, which succeeded and triggered another, indefinitely. This meant a job appeared to be permanently "running" for around two hours, when in reality it was completing very quickly but endlessly re-triggering itself. Fixed by correcting the "Projects to build" field on Job 2 to point at `hoda-ttt-job3-cd-deploy` instead of itself. Once corrected, the same job completed genuinely in around 8 seconds.

## What the result should look like at the end

A developer makes a change to a file on the `dev` branch and pushes it. Within moments, Job 1 fires automatically via the GitHub webhook, runs the app's tests, and if they pass, automatically triggers Job 2. Job 2 merges `dev` into `master`, re-tests the merged result, and if that also passes, pushes the merge to GitHub and automatically triggers Job 3. Job 3 copies the tested code onto the live EC2 instance and restarts the app. The entire process, from push to a visibly updated live app, happens without anyone manually SSHing into anything.
