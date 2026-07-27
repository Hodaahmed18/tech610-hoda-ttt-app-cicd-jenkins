# Setting up my own Jenkins server and rebuilding the 3-job pipeline

## Aim

Rebuild the existing 3-job CI/CD pipeline (test, merge, deploy) on a personally-owned Jenkins server rather than the shared cohort instance, using only the built-in node to run jobs, no agent/worker nodes configured.

## Infrastructure

Built the server instance using Terraform.

**Requirements followed:**
- Ubuntu 24.04 LTS
- Instance type t3.micro (correct size for the Node.js app being deployed)
- 12GB root disk (task requires 12GB rather than the default 8GB)
- Launched in the default VPC
- Security group opening SSH (22), the Jenkins web UI (8080), and the app's port (3000)

```hcl
resource "aws_instance" "hoda_jenkins_server" {
  ami                    = "ami-08c7a4b4f234dfa77"
  instance_type          = "t3.micro"
  key_name               = "hodas-tech610"
  vpc_security_group_ids = [aws_security_group.hoda_jenkins_server_sg.id]

  root_block_device {
    volume_size = 12
  }

  tags = {
    Name = "hoda-own-jenkins-server"
  }
}
```

The correct, current Ubuntu 24.04 AMI was confirmed directly from Canonical's own AWS account, rather than relying on an AMI ID that might be outdated:
```bash
aws ec2 describe-images --owners 099720109477 \
  --filters "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*" "Name=state,Values=available" \
  --query 'reverse(sort_by(Images, &CreationDate))[:1].ImageId' --output text
```
- `--owners 099720109477` is Canonical's own official AWS account ID, querying it directly guarantees a genuine, unmodified Ubuntu image rather than a third party copy
- `--filters` narrows the search to only Ubuntu 24.04 ("noble") server images that are currently available
- `--query 'reverse(sort_by(Images, &CreationDate))[:1].ImageId'` sorts every matching image by creation date, reverses that order so the newest is first, then takes just the first result's ID, this returns the single most recently published matching AMI

Confirmed the instance landed in the account's actual default VPC by comparing its subnet's VPC ID against the account's default VPC ID:
```bash
aws ec2 describe-subnets --subnet-ids <subnet-id> --query 'Subnets[0].VpcId' --output text
aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query 'Vpcs[0].VpcId' --output text
```
The first command looks up which VPC a given subnet belongs to. The second asks AWS directly which VPC in this account is marked as the default one. Comparing the two IDs proves the instance genuinely landed in the default VPC, rather than assuming it based on not having specified one.

## Installing Jenkins

Jenkins requires Java to run. Since Jenkins' current LTS release requires a minimum of Java 21, that version was installed directly:
```bash
sudo apt install -y fontconfig openjdk-21-jre
java -version
```
- `fontconfig` is a small dependency Jenkins needs for generating certain graphs and charts in its UI
- `openjdk-21-jre` installs the Java Runtime Environment, version 21, the actual engine Jenkins runs on top of
- `java -version` confirms which version is now active

Added Jenkins' official package repository, using the currently valid signing key (Jenkins rotates its signing keys periodically, so the key URL used here reflects the version current at the time of setup):
```bash
curl -fsSL https://pkg.jenkins.io/debian-stable/jenkins.io-2026.key | sudo tee /usr/share/keyrings/jenkins-keyring.asc > /dev/null

echo "deb [signed-by=/usr/share/keyrings/jenkins-keyring.asc] https://pkg.jenkins.io/debian-stable binary/" | sudo tee /etc/apt/sources.list.d/jenkins.list > /dev/null

sudo apt update
sudo apt install -y jenkins
```
- `curl -fsSL ... | sudo tee /usr/share/keyrings/jenkins-keyring.asc` downloads Jenkins' public signing key and saves it locally, this is what lets apt verify that packages from Jenkins' repository are genuinely from Jenkins and haven't been tampered with
- the `echo "deb [...] ..." | sudo tee /etc/apt/sources.list.d/jenkins.list` line registers Jenkins' package repository with apt, `signed-by` points apt at the exact key file just downloaded, so only packages signed by that specific key are trusted from this source
- `sudo apt update` refreshes apt's package index so it's aware of the newly added repository
- `sudo apt install -y jenkins` installs Jenkins itself

Confirmed the service was active:
```bash
sudo systemctl status jenkins
```
This checks whether the Jenkins service is currently running, and shows recent log lines if it isn't.

## Logging into the Jenkins GUI

Retrieved the initial admin password and completed the setup wizard:
```bash
sudo cat /var/lib/jenkins/secrets/initialAdminPassword
```
Jenkins generates a one-time password on first install and writes it to this file, this is what's needed to unlock the web setup wizard the very first time it's accessed. Logged in at `http://<server-ip>:8080`, installed the suggested plugin set, created an admin account.

## Setting up credentials

Two separate credentials were configured, matching the pattern used on the original pipeline:

1. A GitHub SSH deploy key, scoped to the CI/CD repository, used by Jobs 1 and 2 to check out and push code.
2. The EC2 deploy target's own SSH key, used only by Job 3 to copy files and restart the app, kept entirely separate from the GitHub credential since the two authenticate against completely different systems.

Since this Jenkins server had never connected to GitHub over SSH before, GitHub's host key needed to be explicitly trusted once, as the actual system user Jenkins runs as:
```bash
sudo -u jenkins ssh -o StrictHostKeyChecking=accept-new git@github.com
```
- `sudo -u jenkins` runs the command as the `jenkins` system user specifically, rather than the regular login user, since Jenkins itself connects to GitHub as this user, not as whoever is logged into the server directly
- `-o StrictHostKeyChecking=accept-new` tells SSH to automatically trust and remember a new, previously unseen host's key rather than interactively prompting for confirmation, appropriate here since GitHub's identity is already well known
- `git@github.com` is the actual connection attempt, GitHub always closes the session immediately afterward since it doesn't provide shell access, the point of this command is only to store GitHub's host key as trusted for future connections, not to log in successfully

## Additional plugins

Two plugins used throughout the pipeline are not part of Jenkins' default suggested plugin set, and were installed manually via Manage Jenkins > Plugins > Available plugins:

- **NodeJS Plugin**, provides "Provide Node & npm bin/folder to PATH" in Build Environment. A named NodeJS tool (version 20.x) was then added under Manage Jenkins > Tools.
- **SSH Agent Plugin**, provides the "SSH Agent" option in Build Environment, used to inject the EC2 credential into shell build steps without referencing a file path directly. Distinct from "SSH Build Agents", which relates to connecting worker/agent nodes and was not needed here, since only the built-in node is used.

Also installed a supporting system library that Node's runtime depends on:
```bash
sudo apt install -y libatomic1
```
`libatomic1` provides low-level atomic operation support that Node's compiled binary relies on internally, it isn't included on a minimal, fresh Ubuntu 24.04 install by default, so it needs to be added explicitly before Node will run correctly.

## Building the three jobs

Rebuilt Jobs 1, 2, and 3 with the same structure as the original pipeline.

**Job 1 (hoda-ttt-job1-ci-test)**
- Source Code Management: Git, SSH repository URL, GitHub credential, branch specifier `*/dev`
- Build Environment: Provide Node & npm bin/folder to PATH, NodeJS 20
- Build Triggers: GitHub hook trigger for GITScm polling
- Build step: `cd app`, `npm ci`, `npm test`
- Post-build: Build other projects (Job 2), trigger only if stable

**Job 2 (hoda-ttt-job2-ci-merge)**
- Source Code Management: same repository and credential, branch specifier `*/dev`
- Additional Behaviours: Merge before build, repository `origin`, branch to merge to `master`
- Build Environment: same NodeJS setup
- Build step: `cd app`, `npm ci`, `npm test`, re-validating the merged result
- Post-build: Git Publisher, "Push Only If Build Succeeds", branch to push `master`
- Also triggers Job 3 on a stable build

**Job 3 (hoda-ttt-job3-cd-deploy)**
- Source Code Management: same repository and credential, branch specifier `*/master`
- Build Environment: SSH Agent, using the EC2 credential
- Build step:
```bash
scp -o StrictHostKeyChecking=no -r app/* ubuntu@<deploy-ip>:/home/ubuntu/app/app/
ssh -o StrictHostKeyChecking=no ubuntu@<deploy-ip> "cd /home/ubuntu/app/app && npm ci && (pm2 delete index; pm2 start index.js)"
```
- `scp -r app/* ...` copies every file from Jenkins' own checked-out workspace directly onto the deploy target instance, keeping the instance itself a passive target with no independent access to GitHub
- `-o StrictHostKeyChecking=no` on both commands skips the interactive host-trust prompt SSH would normally show, necessary here since this runs automatically with nobody present to type a confirmation
- once connected, the remote command changes into the app's directory, installs dependencies fresh with `npm ci`, then removes and restarts the pm2-managed app process, a full delete followed by a fresh start guarantees the process runs with a completely clean state each deploy

A dedicated EC2 instance was launched as this pipeline's deploy target, using the same tictactoe app AMI and security group pattern established in earlier tasks.

## Result

All three jobs run successfully on this Jenkins server using only its built-in node, no agent nodes configured or required at any point. A push to the dev branch tests the code, merges it into master if the tests pass, and deploys the tested, merged code to the target EC2 instance if that second test run also passes, matching the behaviour of the original pipeline built on the shared cohort server.
