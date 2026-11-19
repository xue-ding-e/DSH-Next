[CmdletBinding(DefaultParameterSetName = 'Plan')]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f]{40}\z')]
    [string] $SourceSha,
    [Parameter(Mandatory, ParameterSetName = 'Publish')]
    [ValidatePattern('^\d+\.\d+\.\d+-[0-9A-Za-z.-]+\z')]
    [string] $Version,
    [Parameter(Mandatory, ParameterSetName = 'Publish')]
    [ValidatePattern('^[0-9A-Za-z-]+\z')]
    [string] $Channel
)

$ErrorActionPreference = 'Stop'
$repository = $env:GITHUB_REPOSITORY
$notesPrefix = "Automated DSH Next Windows x64 build from $SourceSha."
$notes = "$notesPrefix The installer is unsigned. Verify SHA256SUMS before installation."

function Invoke-GitHub([string[]] $Arguments) {
    $output = gh @Arguments
    if ($LASTEXITCODE -ne 0) { throw "GitHub CLI failed ($LASTEXITCODE) for $($Arguments[0]) $($Arguments[1])." }
    return $output
}

function Test-MainTip {
    $main = Invoke-GitHub @('api', "repos/$repository/git/ref/heads/main", '--jq', '.object.sha')
    if ($main -cnotmatch '^[0-9a-f]{40}\z') { throw 'GitHub did not return the main branch commit.' }
    if ($main -ceq $SourceSha) { return $true }
    Write-Host "Next release skipped for $SourceSha because main is now at $main."
    return $false
}

function Get-TagCommit([string] $Tag) {
    $ref = "refs/tags/$Tag"
    $references = @(git ls-remote origin $ref "$ref^{}")
    if ($LASTEXITCODE -ne 0) { throw "Could not verify remote tag $Tag." }
    # For an annotated tag, the peeled ref points to the commit.
    $target = $references | Where-Object { $_.EndsWith("`t$ref^{}") } | Select-Object -First 1
    if (!$target) {
        $target = $references | Where-Object { $_.EndsWith("`t$ref") } | Select-Object -First 1
    }
    if ($target) { return ($target -split '\s+')[0] }
}

function Get-SourceReleases([string] $ExpectedTag) {
    $json = Invoke-GitHub @('api', '--paginate', '--slurp', "repos/$repository/releases?per_page=100")
    $pages = ConvertFrom-Json -InputObject ($json -join "`n") -NoEnumerate
    foreach ($page in $pages) {
        foreach ($release in $page) {
            $tag = $release.tag_name
            if ($tag -cnotmatch '^v\d+\.\d+\.\d+-[0-9A-Za-z.-]+\.\d{8}\.\d+\z') { continue }
            $named = $release.name -ceq "DSH Next $($tag.Substring(1))"
            $noted = ([string] $release.body).StartsWith($notesPrefix, [StringComparison]::Ordinal)
            if (!$noted -and (!$named -or $release.target_commitish -cne $SourceSha)) {
                if ($tag -ceq $ExpectedTag) { throw "Release tag $tag belongs to a different release." }
                continue
            }
            $tagCommit = Get-TagCommit $tag
            if (!$release.prerelease -or ($tagCommit -and $tagCommit -cne $SourceSha)) {
                throw "Release $tag conflicts with the Next build for $SourceSha."
            }
            if ($release.draft ? $release.target_commitish -cne $SourceSha : $tagCommit -cne $SourceSha) {
                throw "Release $tag does not identify source $SourceSha."
            }
            $release
        }
    }
}

$checkedOut = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $checkedOut -cne $SourceSha) {
    throw "Expected checkout $SourceSha, got $checkedOut."
}

if (!(Test-MainTip)) { return }
$tag = if ($PSCmdlet.ParameterSetName -eq 'Publish') { "v$Version" }
$releases = @(Get-SourceReleases $tag)
$published = $releases | Where-Object { !$_.draft } | Select-Object -First 1
if ($published) {
    Write-Host "Next release already published for $SourceSha as $($published.tag_name)."
    return
}
$drafts = @($releases | Where-Object { $_.draft })
if ($drafts.Count -gt 1) { throw "Multiple Next release drafts identify $SourceSha." }
$draft = $drafts | Select-Object -First 1
if ($PSCmdlet.ParameterSetName -eq 'Plan') {
    if ($draft) {
        Write-Host "Resuming Next release draft $($draft.tag_name) for $SourceSha."
        "draft_tag=$($draft.tag_name)" >> $env:GITHUB_OUTPUT
    }
    'build=true' >> $env:GITHUB_OUTPUT
    return
}

if ($draft -and $draft.tag_name -cne $tag) {
    throw "Expected release draft $tag, found $($draft.tag_name)."
}
$tagCommit = Get-TagCommit $tag
if ($tagCommit -and $tagCommit -cne $SourceSha) { throw "Remote tag $tag points to $tagCommit, expected $SourceSha." }

$directory = 'apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts'
$assetNames = @( "dsh-next-$Version-win-x64-unsigned.exe", 'SHA256SUMS', "$Channel.yml", 'latest.yml' ) | Select-Object -Unique
$assets = @($assetNames | ForEach-Object { Get-Item -LiteralPath (Join-Path $directory $_) })
if (!$draft) {
    Invoke-GitHub @('release', 'create', $tag, '--repo', $repository, '--target', $SourceSha,
        '--title', "DSH Next $Version", '--draft', '--prerelease', '--notes', $notes)
}

# A partial upload leaves a draft. A retry replaces its assets with the newly verified build.
Invoke-GitHub (@('release', 'upload', $tag, '--repo', $repository, '--clobber') + @($assets.FullName))
$tagCommit = Get-TagCommit $tag
if ($tagCommit -and $tagCommit -cne $SourceSha) { throw "Remote tag $tag points to $tagCommit, expected $SourceSha." }
if (!(Test-MainTip)) { return }
Invoke-GitHub @('release', 'edit', $tag, '--repo', $repository, '--target', $SourceSha, '--notes', $notes, '--draft=false')
if ((Get-TagCommit $tag) -cne $SourceSha) { throw "Published release $tag does not point to $SourceSha." }
Write-Host "Next release published for $SourceSha as $tag."
