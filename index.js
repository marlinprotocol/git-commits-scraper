import 'dotenv/config'
import fs from 'fs'
import { Octokit } from 'octokit'
import axios from 'axios'

const config = JSON.parse(fs.readFileSync('./config.json'))

const octokit = new Octokit({
  auth: process.env.GITHUB_ACCESS_TOKEN
})

const ORG = config.org
const DISCORD_WEBHOOK_URL = config.discordWebhook

const POLLING_INTERVAL = 1 * 60 * 1000

const sendToDiscord = async (repoName, branchName, commitLogs) => {
  const message =
    `**Repository**: ${repoName}\n**Branch**: ${branchName}\n\n` +
    commitLogs
      .map((commit) => {
        return (
          `**Commit Message**: ${commit.commit.message}\n` +
          `**Author**: ${commit.commit.author.name} (<@${commit.author.login}>)\n` +
          `**Date**: ${new Date(commit.commit.author.date).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata'
          })} IST\n` +
          `**Link**: ${commit.html_url}\n` +
          `--------------`
        )
      })
      .join('\n')

  try {
    await axios.post(DISCORD_WEBHOOK_URL, {
      content: message
    })
    console.log('Commit logs sent to Discord')
  } catch (error) {
    console.error('Error sending message to Discord:', error.message)
  }
}

const getOrgCommits = async (org, since) => {
  const repos = await getOrgRepos(org, since)
  console.log('Fetched repos:', repos)

  const emptyRepos = []
  const reposUpdates = repos.map(async (repoInfo) => {
    const branches = await getRepoBranches(repoInfo.owner.login, repoInfo.name)
    console.log(`Fetched branches for ${repoInfo.name}:`, branches)

    if (branches.length === 0) {
      console.log(`Repo ${repoInfo.name} has no branches (empty)`)
      emptyRepos.push(repoInfo.name)
      return null
    }

    const branchCommits = await Promise.all(
      branches.map(async (branch) => {
        const commits = await getBranchCommits(
          repoInfo.owner.login,
          repoInfo.name,
          branch.name,
          since
        )
        if (commits.length === 0) {
          console.log(`No recent commits on branch ${branch.name} of repo ${repoInfo.name}`)
        } else {
          console.log(
            `Fetched ${commits.length} commits on branch ${branch.name} of repo ${repoInfo.name}`
          )
        }
        return { branch: branch.name, commits }
      })
    )

    return { repo: repoInfo.name, branchCommits }
  })

  const filteredReposUpdates = (await Promise.all(reposUpdates)).filter(Boolean)
  const orgCommits = [].concat.apply([], filteredReposUpdates)

  if (emptyRepos.length > 0) {
    console.log('Empty repositories (no branches):', emptyRepos)
  }

  if (repos.length > 0) {
    fs.writeFileSync('./commits.json', JSON.stringify(orgCommits, null, 2))
  }

  writeLastCheck(new Date())
  return orgCommits
}

const getRepoBranches = async (owner, repo) => {
  try {
    const branches = await octokit.request('GET /repos/{owner}/{repo}/branches', {
      owner,
      repo,
      headers: {
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    return branches.data
  } catch (error) {
    console.error(`Error fetching branches for ${owner}/${repo}:`, error.message)
    return []
  }
}

const getBranchCommits = async (owner, repo, branch, since) => {
  since = ISODateString(new Date(since))
  try {
    const commits = await octokit.request(
      'GET /repos/{owner}/{repo}/commits?sha={branch}&since={since}',
      {
        owner,
        repo,
        branch,
        since,
        headers: {
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    )

    if (commits.data.length > 0) {
      await sendToDiscord(repo, branch, commits.data)
    }

    return commits.data
  } catch (error) {
    console.error(`Error fetching commits for branch ${branch} of ${owner}/${repo}:`, error.message)
    return []
  }
}

const getOrgRepos = async (org, since) => {
  let repoList = []
  let pages = 1

  while (true) {
    console.log('Fetching page', pages)
    const repoListPage = (
      await octokit.request(
        'GET /orgs/{org}/repos?type=public&sort=pushed&per_page=10&page={pages}',
        {
          org,
          pages,
          headers: {
            'X-GitHub-Api-Version': '2022-11-28'
          }
        }
      )
    ).data

    if (repoListPage.length == 0) break
    pages++
    let index = repoListPage.length - 1

    let pushedAt = new Date(repoListPage[index].pushed_at).getTime()

    while (pushedAt < since) {
      repoListPage.pop()
      index--
      if (index < 0) break
      pushedAt = new Date(repoListPage[index].pushed_at).getTime()
    }

    repoList = repoList.concat(repoListPage)
    if (pushedAt < since) break
  }

  return repoList
}

const getLastCheck = async () => {
  const data = JSON.parse(fs.readFileSync('./data.json'))
  console.log('last_checked: ', data.last_checked, new Date(data.last_checked).getTime())
  return new Date(data.last_checked).getTime()
}

const writeLastCheck = async (last_checked) => {
  const data = JSON.parse(fs.readFileSync('./data.json'))
  data.last_checked = ISODateString(last_checked)
  fs.writeFileSync('./data.json', JSON.stringify(data, null, 2))
}

const ISODateString = (d) => {
  function pad(n) {
    return n < 10 ? '0' + n : n
  }
  return (
    d.getUTCFullYear() +
    '-' +
    pad(d.getUTCMonth() + 1) +
    '-' +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    ':' +
    pad(d.getUTCMinutes()) +
    ':' +
    pad(d.getUTCSeconds()) +
    'Z'
  )
}

const main = async () => {
  const since = await getLastCheck()
  await getOrgCommits(ORG, since)
}

const startPolling = async () => {
  let isFetching = false

  try {
    console.log('Fetching commits...')
    await main()
    console.log('Fetching completed.')

    setInterval(async () => {
      if (isFetching) {
        console.log('Previous fetch still in progress, skipping this cycle.')
        return
      }

      try {
        isFetching = true
        console.log('Fetching commits...')
        await main()
        console.log('Fetching completed.')
      } catch (error) {
        console.error('Error during fetch:', error.message)
      } finally {
        isFetching = false
      }
    }, POLLING_INTERVAL)
  } catch (error) {
    console.error('Error during initial fetch:', error.message)
  }
}

startPolling()
