#!/bin/sh
# Sync the GitHub mirror from local master.
#
# Why this exists: the two repositories are published under different identities
# so that each platform links the commits to the maintainer's own account and no
# platform's no-reply address leaks into the other.
#
#   Gitee  小鸟游星野 <HOSHINO6@users.noreply.gitee.com>
#   GitHub ホシノ     <186796588+HOSHINO61@users.noreply.github.com>
#
# A commit carries only one author, so the trees are identical while the SHAs
# differ. This script rebuilds branch 'gh' by replaying master linearly with the
# GitHub identity, then force-pushes it to the GitHub remote.
#
# Usage:  sh scripts/sync-github.sh [--push]
#
# Pushing from Windows behind a proxy (git 2.56 + PortableGit, verified):
#
#   git config http.proxy http://127.0.0.1:31181
#   git config http.sslVerify false          # schannel CRL check dies with
#                                            # CRYPT_E_NO_REVOCATION_CHECK;
#                                            # the OpenSSL backend then wants a
#                                            # CA bundle that is not wired up
#   B64=$(printf 'x-access-token:%s' "$PAT" | base64)
#   git config http.extraheader "Authorization: Basic $B64"
#   sh scripts/sync-github.sh --push
#   git -c http.proxy=... push github <gh-head>:refs/tags/v1.0.1
#   git config --unset http.extraheader
#   git config --unset http.sslVerify
#   git config --unset http.proxy
#
# api.github.com is reachable directly even when github.com:443 is not, so
# releases can be created and assets uploaded without the proxy at all.
#
# A PAT must never be left in .git/config -- the three --unset lines above are
# part of the procedure, not an afterthought.
set -e

GH_NAME="ホシノ"
GH_MAIL="186796588+HOSHINO61@users.noreply.github.com"
REMOTE="github"
BRANCH="master"

git rev-parse --verify "$BRANCH" >/dev/null 2>&1 || {
    echo "error: branch '$BRANCH' not found" >&2
    exit 1
}

prev=""
first=""
for c in $(git rev-list --reverse "$BRANCH"); do
    tree=$(git rev-parse "$c^{tree}")
    when=$(git log -1 --format=%aI "$c")

    export GIT_AUTHOR_NAME="$GH_NAME"
    export GIT_AUTHOR_EMAIL="$GH_MAIL"
    export GIT_COMMITTER_NAME="$GH_NAME"
    export GIT_COMMITTER_EMAIL="$GH_MAIL"
    export GIT_AUTHOR_DATE="$when"
    export GIT_COMMITTER_DATE="$when"

    if [ -z "$prev" ]; then
        prev=$(git log -1 --format=%B "$c" | git commit-tree "$tree")
        first="$prev"
    else
        prev=$(git log -1 --format=%B "$c" | git commit-tree "$tree" -p "$prev")
    fi
done

git branch -f gh "$prev"

echo "gh built at $prev"
echo "v1.0 commit  $first"
echo "--- history ---"
git log --format="%h %an <%ae>  %s" -4 gh

echo "--- tree matches master? ---"
if [ "$(git rev-parse gh^{tree})" = "$(git rev-parse "$BRANCH^{tree}")" ]; then
    echo "yes"
else
    echo "NO - aborting" >&2
    exit 1
fi

if [ "$1" = "--push" ]; then
    git push "$REMOTE" "gh:$BRANCH" --force
    # The tag has to point at the replayed *head*: tagging "$first" would put
    # the release on the repository's very first commit.
    git push "$REMOTE" "$prev:refs/tags/${TAG:-v1.0}" --force
    echo "pushed to $REMOTE"
else
    echo
    echo "dry run; re-run with --push to update $REMOTE"
fi
