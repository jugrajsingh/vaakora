//! `vaakora agent install|uninstall`: writes the two explicit-only skills (`vaakora-read`,
//! `vaakora-stop`) for Claude Code (`~/.claude/skills`) and Codex (`~/.agents/skills`).
//!
//! Formats (checked against the docs on 2026-11-23): Claude Code,
//! <https://code.claude.com/docs/en/skills>, keeps a personal skill in
//! `~/.claude/skills/<name>/SKILL.md` and `disable-model-invocation: true` keeps it from loading
//! unless the user types `/<name>`; Codex, <https://learn.chatgpt.com/docs/build-skills>, keeps a
//! user skill in `$HOME/.agents/skills/<name>/SKILL.md` and
//! `agents/openai.yaml` `policy.allow_implicit_invocation: false` keeps it to an explicit
//! `$<name>`.
//!
//! The installer owns only what it wrote. Every skill folder it writes holds [`MARKER`]; a folder
//! without the marker is never written, moved or deleted. The whole plan is computed before any
//! file is touched, so a conflict stops the command with nothing written. A reinstall over a
//! marked folder overwrites the files vaakora wrote there (and only those); an uninstall removes
//! those files and the marker, then the `agents` and skill folders only when nothing else is in
//! them, and reports every leftover as `skip`.

use std::borrow::Cow;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::cli::AgentAction;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Agent {
    Claude,
    Codex,
}

/// One file of a skill: its path inside the skill folder and its compiled-in contents.
pub(crate) struct SkillFile {
    pub relative: &'static str,
    pub contents: &'static str,
}

pub(crate) struct Skill {
    pub agent: Agent,
    pub name: &'static str,
    pub files: &'static [SkillFile],
}

pub(crate) const SKILLS: &[Skill] = &[
    Skill {
        agent: Agent::Claude,
        name: "vaakora-read",
        files: &[SkillFile {
            relative: "SKILL.md",
            contents: include_str!("skills/claude/vaakora-read/SKILL.md"),
        }],
    },
    Skill {
        agent: Agent::Claude,
        name: "vaakora-stop",
        files: &[SkillFile {
            relative: "SKILL.md",
            contents: include_str!("skills/claude/vaakora-stop/SKILL.md"),
        }],
    },
    Skill {
        agent: Agent::Codex,
        name: "vaakora-read",
        files: &[
            SkillFile {
                relative: "SKILL.md",
                contents: include_str!("skills/codex/vaakora-read/SKILL.md"),
            },
            SkillFile {
                relative: "agents/openai.yaml",
                contents: include_str!("skills/codex/vaakora-read/agents/openai.yaml"),
            },
        ],
    },
    Skill {
        agent: Agent::Codex,
        name: "vaakora-stop",
        files: &[
            SkillFile {
                relative: "SKILL.md",
                contents: include_str!("skills/codex/vaakora-stop/SKILL.md"),
            },
            SkillFile {
                relative: "agents/openai.yaml",
                contents: include_str!("skills/codex/vaakora-stop/agents/openai.yaml"),
            },
        ],
    },
];

/// The file that marks a skill folder as written by vaakora.
pub(crate) const MARKER: &str = ".vaakora-skill";

#[derive(Debug, PartialEq)]
pub(crate) enum Step {
    Write(PathBuf),
    Remove(PathBuf),
    Skip(PathBuf),
}

/// Where an agent keeps its user skills, relative to the home folder.
fn skills_root(agent: Agent) -> &'static str {
    match agent {
        Agent::Claude => ".claude/skills",
        Agent::Codex => ".agents/skills",
    }
}

pub(crate) fn skill_dir(home: &Path, agent: Agent, name: &str) -> PathBuf {
    home.join(skills_root(agent)).join(name)
}

/// The agents a command applies to: neither flag means both.
pub(crate) fn selected_agents(claude: bool, codex: bool) -> Vec<Agent> {
    match (claude, codex) {
        (true, false) => vec![Agent::Claude],
        (false, true) => vec![Agent::Codex],
        _ => vec![Agent::Claude, Agent::Codex],
    }
}

fn marker_contents() -> String {
    format!("vaakora {}\n", env!("CARGO_PKG_VERSION"))
}

fn selected_skills(agents: &[Agent]) -> impl Iterator<Item = &'static Skill> + '_ {
    SKILLS.iter().filter(|s| agents.contains(&s.agent))
}

/// True when something (a file, a folder, a link, even a dangling one) is at `path`.
fn exists(path: &Path) -> bool {
    path.symlink_metadata().is_ok()
}

/// True when `path` is a regular file itself, not a link to one.
fn is_regular_file(path: &Path) -> bool {
    path.symlink_metadata().is_ok_and(|m| m.is_file())
}

/// True when `path` is a real folder, not a link to one.
fn is_real_dir(path: &Path) -> bool {
    path.symlink_metadata().is_ok_and(|m| m.is_dir())
}

/// The first thing on the way to `dir/relative` that vaakora would have to write through but did
/// not write: a link, or a file where a folder goes, or a folder or link where the file goes.
fn blocked_target(dir: &Path, relative: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = relative.split('/').collect();
    let mut current = dir.to_path_buf();
    for (i, part) in parts.iter().enumerate() {
        current.push(part);
        let Ok(meta) = current.symlink_metadata() else {
            // Nothing here, so nothing deeper exists (or the folder cannot be read: the write
            // reports that itself).
            return None;
        };
        let last = i + 1 == parts.len();
        let usable = if last { meta.is_file() } else { meta.is_dir() };
        if !usable {
            return Some(current);
        }
    }
    None
}

/// Every write an install makes, marker first in each folder. `Err(path)` names the first folder
/// that exists without the marker (or the first file below a marked folder that vaakora did not
/// write); nothing has been touched when it returns.
pub(crate) fn plan_install(home: &Path, agents: &[Agent]) -> Result<Vec<Step>, PathBuf> {
    let mut steps = Vec::new();
    for skill in selected_skills(agents) {
        let dir = skill_dir(home, skill.agent, skill.name);
        if exists(&dir) {
            if !is_regular_file(&dir.join(MARKER)) {
                return Err(dir);
            }
            for file in skill.files {
                if let Some(blocked) = blocked_target(&dir, file.relative) {
                    return Err(blocked);
                }
            }
        }
        steps.push(Step::Write(dir.join(MARKER)));
        for file in skill.files {
            steps.push(Step::Write(dir.join(file.relative)));
        }
    }
    Ok(steps)
}

/// True when `dir` (at `relative` inside the skill folder) would hold nothing once vaakora's own
/// files are gone: every entry is one of those files, or a folder that is itself in that state.
fn empties_out(dir: &Path, relative: &Path, own: &HashSet<PathBuf>) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries {
        let Ok(entry) = entry else { return false };
        let rel = relative.join(entry.file_name());
        let path = entry.path();
        if own.contains(&rel) && is_regular_file(&path) {
            continue;
        }
        let holds_own_files = own.iter().any(|f| f.starts_with(&rel) && f != &rel);
        if holds_own_files && is_real_dir(&path) && empties_out(&path, &rel, own) {
            continue;
        }
        return false;
    }
    true
}

/// What an uninstall does: for each marked folder, remove the files vaakora wrote and the marker,
/// then the `agents` and skill folders only when nothing else is in them (`Skip` for a folder
/// that holds something else). An existing folder without the marker is `Skip`ped untouched.
pub(crate) fn plan_uninstall(home: &Path, agents: &[Agent]) -> Vec<Step> {
    let mut steps = Vec::new();
    for skill in selected_skills(agents) {
        let dir = skill_dir(home, skill.agent, skill.name);
        if !exists(&dir) {
            continue;
        }
        if !is_regular_file(&dir.join(MARKER)) {
            steps.push(Step::Skip(dir));
            continue;
        }
        let mut own: HashSet<PathBuf> = skill
            .files
            .iter()
            .map(|f| PathBuf::from(f.relative))
            .collect();
        own.insert(PathBuf::from(MARKER));
        for file in skill.files {
            let path = dir.join(file.relative);
            // Every component between the skill folder and the file is checked, not only the
            // last: a linked `agents` folder leads to files vaakora never wrote.
            if let Some(blocked) = blocked_target(&dir, file.relative) {
                let skip = Step::Skip(blocked);
                if !steps.contains(&skip) {
                    steps.push(skip);
                }
            } else if is_regular_file(&path) {
                steps.push(Step::Remove(path));
            }
        }
        let mut subdirs: Vec<PathBuf> = skill
            .files
            .iter()
            .filter_map(|f| Path::new(f.relative).parent())
            .filter(|p| !p.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .collect();
        subdirs.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
        subdirs.dedup();
        for sub in subdirs {
            let path = dir.join(&sub);
            if !is_real_dir(&path) {
                continue;
            }
            if empties_out(&path, &sub, &own) {
                steps.push(Step::Remove(path));
            } else {
                steps.push(Step::Skip(path));
            }
        }
        steps.push(Step::Remove(dir.join(MARKER)));
        if empties_out(&dir, Path::new(""), &own) {
            steps.push(Step::Remove(dir));
        } else {
            steps.push(Step::Skip(dir));
        }
    }
    steps
}

/// The compiled-in contents for a path `plan_install` produced.
fn contents_for(path: &Path) -> Option<Cow<'static, str>> {
    if path.file_name().is_some_and(|n| n == MARKER) {
        return Some(Cow::Owned(marker_contents()));
    }
    for skill in SKILLS {
        for file in skill.files {
            let tail = Path::new(skills_root(skill.agent))
                .join(skill.name)
                .join(file.relative);
            if path.ends_with(&tail) {
                return Some(Cow::Borrowed(file.contents));
            }
        }
    }
    None
}

/// Carries out `steps` in order: `Write` creates the parent folders and writes the compiled-in
/// file, `Remove` deletes a file or an empty folder (a folder that has since gained a file is
/// left), `Skip` does nothing.
pub(crate) fn apply(steps: &[Step]) -> std::io::Result<()> {
    for step in steps {
        match step {
            Step::Write(path) => {
                let contents = contents_for(path).ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "not a vaakora skill file",
                    )
                })?;
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(path, contents.as_bytes())?;
            }
            Step::Remove(path) => {
                let meta = match path.symlink_metadata() {
                    Ok(meta) => meta,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e),
                };
                if meta.is_dir() {
                    match std::fs::remove_dir(path) {
                        Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
                        other => other?,
                    }
                } else if meta.is_file() {
                    std::fs::remove_file(path)?;
                } else {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "not a file or folder vaakora wrote",
                    ));
                }
            }
            Step::Skip(_) => {}
        }
    }
    Ok(())
}

/// Why a `Skip` was planned: a link is never followed; a skill folder without the marker was
/// never ours; any other skipped path holds files vaakora did not write.
fn skip_reason(path: &Path) -> &'static str {
    let is_skill_dir = SKILLS
        .iter()
        .any(|s| path.ends_with(Path::new(skills_root(s.agent)).join(s.name)));
    if path
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        "a link, left alone"
    } else if is_skill_dir && !is_regular_file(&path.join(MARKER)) {
        "not installed by vaakora"
    } else {
        "holds files vaakora did not write"
    }
}

/// `vaakora agent install|uninstall`; returns the exit code. The plan is printed first (one line
/// per step), then carried out unless `--dry-run`.
pub(crate) fn run_agent(
    action: AgentAction,
    home: Option<PathBuf>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let (installing, claude, codex, dry_run) = match action {
        AgentAction::Install {
            claude,
            codex,
            dry_run,
        } => (true, claude, codex, dry_run),
        AgentAction::Uninstall {
            claude,
            codex,
            dry_run,
        } => (false, claude, codex, dry_run),
    };
    let Some(home) = home else {
        let _ = writeln!(err, "vaakora: cannot find your home folder");
        return 1;
    };
    let agents = selected_agents(claude, codex);
    let steps = if installing {
        match plan_install(&home, &agents) {
            Ok(steps) => steps,
            Err(path) => {
                let _ = writeln!(
                    err,
                    "vaakora: {} exists and was not installed by vaakora; nothing was written",
                    path.display()
                );
                return 1;
            }
        }
    } else {
        plan_uninstall(&home, &agents)
    };
    for step in &steps {
        let _ = match step {
            Step::Write(path) => writeln!(out, "write {}", path.display()),
            Step::Remove(path) => writeln!(out, "remove {}", path.display()),
            Step::Skip(path) => writeln!(out, "skip {} ({})", path.display(), skip_reason(path)),
        };
    }
    if dry_run {
        return 0;
    }
    match apply(&steps) {
        Ok(()) => 0,
        Err(e) => {
            let verb = if installing { "write" } else { "remove" };
            let _ = writeln!(err, "vaakora: could not {verb} the skills: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn version_marker() -> String {
        format!("vaakora {}\n", env!("CARGO_PKG_VERSION"))
    }

    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    struct Ran {
        code: i32,
        out: String,
        err: String,
    }

    impl Ran {
        fn lines(&self, verb: &str) -> Vec<&str> {
            self.out
                .lines()
                .filter(|l| l.starts_with(&format!("{verb} ")))
                .collect()
        }
    }

    fn run(action: AgentAction, home: &Path) -> Ran {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run_agent(action, Some(home.to_path_buf()), &mut out, &mut err);
        Ran {
            code,
            out: String::from_utf8(out).unwrap(),
            err: String::from_utf8(err).unwrap(),
        }
    }

    fn install(home: &Path, claude: bool, codex: bool, dry_run: bool) -> Ran {
        run(
            AgentAction::Install {
                claude,
                codex,
                dry_run,
            },
            home,
        )
    }

    fn uninstall(home: &Path, claude: bool, codex: bool, dry_run: bool) -> Ran {
        run(
            AgentAction::Uninstall {
                claude,
                codex,
                dry_run,
            },
            home,
        )
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn put(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn skill(agent: Agent, name: &str) -> &'static Skill {
        SKILLS
            .iter()
            .find(|s| s.agent == agent && s.name == name)
            .unwrap()
    }

    fn file(agent: Agent, name: &str, relative: &str) -> &'static str {
        skill(agent, name)
            .files
            .iter()
            .find(|f| f.relative == relative)
            .unwrap()
            .contents
    }

    /// The `key: value` lines between the first two `---` lines.
    fn frontmatter(text: &str) -> Vec<(String, String)> {
        let mut lines = text.lines();
        assert_eq!(lines.next(), Some("---"), "frontmatter must open the file");
        let mut pairs = Vec::new();
        for line in lines {
            if line == "---" {
                return pairs;
            }
            let (key, value) = line.split_once(": ").expect("key: value");
            pairs.push((key.to_string(), value.to_string()));
        }
        panic!("frontmatter is not closed");
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn every_skill_text() -> Vec<(String, &'static str)> {
        let mut all = Vec::new();
        for skill in SKILLS {
            for f in skill.files {
                all.push((
                    format!("{:?}/{}/{}", skill.agent, skill.name, f.relative),
                    f.contents,
                ));
            }
        }
        all
    }

    #[test]
    fn no_flag_selects_both() {
        assert_eq!(
            selected_agents(false, false),
            vec![Agent::Claude, Agent::Codex]
        );
        assert_eq!(
            selected_agents(true, true),
            vec![Agent::Claude, Agent::Codex]
        );
        assert_eq!(selected_agents(true, false), vec![Agent::Claude]);
        assert_eq!(selected_agents(false, true), vec![Agent::Codex]);
    }

    #[test]
    fn skill_dirs_follow_each_agents_documented_root() {
        let h = Path::new("/h");
        assert_eq!(
            skill_dir(h, Agent::Claude, "vaakora-read"),
            Path::new("/h/.claude/skills/vaakora-read")
        );
        assert_eq!(
            skill_dir(h, Agent::Codex, "vaakora-stop"),
            Path::new("/h/.agents/skills/vaakora-stop")
        );
    }

    #[test]
    fn install_plan_lists_every_file() {
        let h = home();
        let steps = plan_install(h.path(), &[Agent::Claude, Agent::Codex]).unwrap();
        assert_eq!(steps.len(), 10, "6 skill files and 4 markers: {steps:?}");
        let r = h.path().join(".claude/skills");
        let c = h.path().join(".agents/skills");
        let expected: Vec<Step> = [
            r.join("vaakora-read/.vaakora-skill"),
            r.join("vaakora-read/SKILL.md"),
            r.join("vaakora-stop/.vaakora-skill"),
            r.join("vaakora-stop/SKILL.md"),
            c.join("vaakora-read/.vaakora-skill"),
            c.join("vaakora-read/SKILL.md"),
            c.join("vaakora-read/agents/openai.yaml"),
            c.join("vaakora-stop/.vaakora-skill"),
            c.join("vaakora-stop/SKILL.md"),
            c.join("vaakora-stop/agents/openai.yaml"),
        ]
        .into_iter()
        .map(Step::Write)
        .collect();
        assert_eq!(steps, expected);
    }

    #[test]
    fn install_plan_writes_the_marker_first_in_every_folder() {
        let h = home();
        let steps = plan_install(h.path(), &[Agent::Claude, Agent::Codex]).unwrap();
        let mut seen: Vec<PathBuf> = Vec::new();
        for step in &steps {
            let Step::Write(path) = step else {
                panic!("only writes: {step:?}")
            };
            let dir = path
                .ancestors()
                .find(|a| {
                    a.parent().is_some_and(|p| {
                        p.ends_with(".claude/skills") || p.ends_with(".agents/skills")
                    })
                })
                .unwrap()
                .to_path_buf();
            if !seen.contains(&dir) {
                assert_eq!(
                    path.file_name().unwrap(),
                    MARKER,
                    "the first write in {dir:?} must be the marker"
                );
                seen.push(dir);
            }
        }
        assert_eq!(seen.len(), 4);
    }

    #[test]
    fn dry_run_writes_nothing() {
        let h = home();
        let ran = install(h.path(), false, false, true);
        assert_eq!(ran.code, 0, "{}", ran.err);
        assert_eq!(ran.lines("write").len(), 10, "{}", ran.out);
        assert!(!h.path().join(".claude").exists());
        assert!(!h.path().join(".agents").exists());
    }

    #[test]
    fn install_writes_files_and_markers() {
        let h = home();
        let ran = install(h.path(), false, false, false);
        assert_eq!(ran.code, 0, "{}", ran.err);
        assert_eq!(ran.lines("write").len(), 10);
        let claude_read = read(&h.path().join(".claude/skills/vaakora-read/SKILL.md"));
        assert_eq!(claude_read, file(Agent::Claude, "vaakora-read", "SKILL.md"));
        assert!(claude_read.contains("disable-model-invocation: true"));
        let yaml = read(
            &h.path()
                .join(".agents/skills/vaakora-read/agents/openai.yaml"),
        );
        assert!(yaml.contains("allow_implicit_invocation: false"));
        for dir in [
            ".claude/skills/vaakora-read",
            ".claude/skills/vaakora-stop",
            ".agents/skills/vaakora-read",
            ".agents/skills/vaakora-stop",
        ] {
            assert_eq!(
                read(&h.path().join(dir).join(".vaakora-skill")),
                version_marker()
            );
        }
    }

    #[test]
    fn foreign_dir_stops_install_and_writes_nothing() {
        let h = home();
        let mine = h.path().join(".claude/skills/vaakora-read/SKILL.md");
        put(&mine, "mine");
        let ran = install(h.path(), false, false, false);
        assert_eq!(ran.code, 1);
        assert_eq!(
            ran.err,
            format!(
                "vaakora: {} exists and was not installed by vaakora; nothing was written\n",
                h.path().join(".claude/skills/vaakora-read").display()
            )
        );
        assert_eq!(read(&mine), "mine");
        assert!(!h.path().join(".agents").exists());
        assert!(!h.path().join(".claude/skills/vaakora-stop").exists());
        assert!(!h
            .path()
            .join(".claude/skills/vaakora-read/.vaakora-skill")
            .exists());
    }

    #[test]
    fn foreign_dir_stops_a_dry_run_too() {
        let h = home();
        put(
            &h.path().join(".agents/skills/vaakora-stop/notes.txt"),
            "mine",
        );
        let ran = install(h.path(), false, false, true);
        assert_eq!(ran.code, 1);
        assert!(ran.out.is_empty(), "{}", ran.out);
    }

    #[test]
    fn foreign_dir_of_the_other_agent_does_not_block_a_single_agent_install() {
        let h = home();
        put(
            &h.path().join(".agents/skills/vaakora-read/SKILL.md"),
            "mine",
        );
        let ran = install(h.path(), true, false, false);
        assert_eq!(ran.code, 0, "{}", ran.err);
        assert_eq!(
            read(&h.path().join(".agents/skills/vaakora-read/SKILL.md")),
            "mine"
        );
    }

    #[test]
    fn a_marker_that_is_a_symlink_is_not_a_marker() {
        let h = home();
        let dir = h.path().join(".claude/skills/vaakora-read");
        let elsewhere = h.path().join("elsewhere");
        put(&elsewhere, &version_marker());
        std::fs::create_dir_all(&dir).unwrap();
        symlink(&elsewhere, dir.join(MARKER)).unwrap();
        let ran = install(h.path(), true, false, false);
        assert_eq!(ran.code, 1);
        assert_eq!(read(&elsewhere), version_marker());
        assert!(!dir.join("SKILL.md").exists());
    }

    #[test]
    fn a_symlink_where_a_skill_file_goes_stops_the_install() {
        let h = home();
        install(h.path(), true, false, false);
        let target = h.path().join("someone-elses-file");
        put(&target, "theirs");
        let skill_md = h.path().join(".claude/skills/vaakora-stop/SKILL.md");
        std::fs::remove_file(&skill_md).unwrap();
        symlink(&target, &skill_md).unwrap();
        let ran = install(h.path(), true, false, false);
        assert_eq!(ran.code, 1);
        assert_eq!(read(&target), "theirs");
        assert!(
            ran.err.contains(&skill_md.display().to_string()),
            "{}",
            ran.err
        );
    }

    #[test]
    fn reinstall_over_marked_dirs_updates() {
        let h = home();
        assert_eq!(install(h.path(), false, false, false).code, 0);
        let skill_md = h.path().join(".claude/skills/vaakora-read/SKILL.md");
        let extra = h.path().join(".claude/skills/vaakora-read/notes.txt");
        put(&skill_md, "stale");
        put(&extra, "kept");
        put(
            &h.path().join(".claude/skills/vaakora-read/.vaakora-skill"),
            "vaakora 0.0.1\n",
        );
        let ran = install(h.path(), false, false, false);
        assert_eq!(ran.code, 0, "{}", ran.err);
        assert_eq!(
            read(&skill_md),
            file(Agent::Claude, "vaakora-read", "SKILL.md")
        );
        assert_eq!(
            read(&h.path().join(".claude/skills/vaakora-read/.vaakora-skill")),
            version_marker()
        );
        assert_eq!(
            read(&extra),
            "kept",
            "a reinstall writes only its own files"
        );
    }

    #[test]
    fn uninstall_removes_only_marked() {
        let h = home();
        install(h.path(), false, false, false);
        let foreign = h.path().join(".agents/skills/vaakora-stop");
        std::fs::remove_dir_all(&foreign).unwrap();
        put(&foreign.join("SKILL.md"), "mine");
        let ran = uninstall(h.path(), false, false, false);
        assert_eq!(ran.code, 0, "{}", ran.err);
        assert!(!h.path().join(".claude/skills/vaakora-read").exists());
        assert!(!h.path().join(".claude/skills/vaakora-stop").exists());
        assert!(!h.path().join(".agents/skills/vaakora-read").exists());
        assert_eq!(read(&foreign.join("SKILL.md")), "mine");
        assert!(
            ran.out.contains(&format!(
                "skip {} (not installed by vaakora)",
                foreign.display()
            )),
            "{}",
            ran.out
        );
    }

    #[test]
    fn uninstall_removes_the_files_the_marker_and_the_empty_folders() {
        let h = home();
        install(h.path(), false, false, false);
        let ran = uninstall(h.path(), false, false, false);
        assert_eq!(ran.code, 0, "{}", ran.err);
        assert!(ran.lines("skip").is_empty(), "{}", ran.out);
        // 2 Claude skills: file, marker, folder; 2 Codex skills: 2 files, agents/, marker, folder
        assert_eq!(ran.lines("remove").len(), 2 * 3 + 2 * 5, "{}", ran.out);
        for dir in [".claude/skills/vaakora-read", ".agents/skills/vaakora-stop"] {
            assert!(!h.path().join(dir).exists(), "{dir}");
        }
        assert!(
            h.path().join(".claude/skills").is_dir(),
            "the skills folder is not ours"
        );
        assert!(h.path().join(".agents/skills").is_dir());
    }

    #[test]
    fn uninstall_keeps_files_it_did_not_write() {
        let h = home();
        install(h.path(), false, false, false);
        let notes = h.path().join(".claude/skills/vaakora-read/notes.txt");
        let user_yaml = h
            .path()
            .join(".agents/skills/vaakora-read/agents/extra.yaml");
        put(&notes, "mine");
        put(&user_yaml, "mine");
        let ran = uninstall(h.path(), false, false, false);
        assert_eq!(ran.code, 0, "{}", ran.err);
        assert_eq!(read(&notes), "mine");
        assert_eq!(read(&user_yaml), "mine");
        assert!(!h
            .path()
            .join(".claude/skills/vaakora-read/SKILL.md")
            .exists());
        assert!(!h
            .path()
            .join(".claude/skills/vaakora-read/.vaakora-skill")
            .exists());
        assert!(!h
            .path()
            .join(".agents/skills/vaakora-read/SKILL.md")
            .exists());
        assert!(!h
            .path()
            .join(".agents/skills/vaakora-read/agents/openai.yaml")
            .exists());
        let skips = ran.lines("skip");
        assert_eq!(skips.len(), 3, "{}", ran.out);
        for dir in [
            h.path().join(".claude/skills/vaakora-read"),
            h.path().join(".agents/skills/vaakora-read/agents"),
            h.path().join(".agents/skills/vaakora-read"),
        ] {
            assert!(
                ran.out.contains(&format!(
                    "skip {} (holds files vaakora did not write)",
                    dir.display()
                )),
                "{dir:?}: {}",
                ran.out
            );
        }
        assert!(!h.path().join(".claude/skills/vaakora-stop").exists());
    }

    #[test]
    fn uninstall_never_removes_a_symlink_in_place_of_its_file() {
        let h = home();
        install(h.path(), true, false, false);
        let target = h.path().join("someone-elses-file");
        put(&target, "theirs");
        let skill_md = h.path().join(".claude/skills/vaakora-stop/SKILL.md");
        std::fs::remove_file(&skill_md).unwrap();
        symlink(&target, &skill_md).unwrap();
        let ran = uninstall(h.path(), true, false, false);
        assert_eq!(ran.code, 0, "{}", ran.err);
        assert_eq!(read(&target), "theirs");
        assert!(skill_md
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!h
            .path()
            .join(".claude/skills/vaakora-stop/.vaakora-skill")
            .exists());
    }

    /// A user folder with a file at the same name vaakora writes, reached through a link.
    fn linked_agents_folder(h: &Path) -> (PathBuf, PathBuf, PathBuf) {
        install(h, false, true, false);
        let agents = h.join(".agents/skills/vaakora-read/agents");
        std::fs::remove_dir_all(&agents).unwrap();
        let foreign = h.join("user-managed-config");
        let foreign_yaml = foreign.join("openai.yaml");
        put(
            &foreign_yaml,
            "user-authored config, never installed by vaakora",
        );
        symlink(&foreign, &agents).unwrap();
        (agents, foreign, foreign_yaml)
    }

    #[test]
    fn uninstall_preserves_a_file_behind_a_symlinked_agents_folder() {
        let h = home();
        let (agents, foreign, foreign_yaml) = linked_agents_folder(h.path());
        let ran = uninstall(h.path(), false, true, false);
        assert_eq!(ran.code, 0, "{}", ran.err);
        assert_eq!(
            read(&foreign_yaml),
            "user-authored config, never installed by vaakora"
        );
        assert!(foreign.is_dir());
        assert!(agents.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_link(&agents).unwrap(), foreign);
        assert!(
            ran.out
                .contains(&format!("skip {} (a link, left alone)", agents.display())),
            "{}",
            ran.out
        );
        // the other Codex skill, with no link, is uninstalled normally
        assert!(!h.path().join(".agents/skills/vaakora-stop").exists());
        // the linked skill keeps its folder (the link is in it) but loses its own files
        assert!(!h
            .path()
            .join(".agents/skills/vaakora-read/SKILL.md")
            .exists());
        assert!(!h
            .path()
            .join(".agents/skills/vaakora-read/.vaakora-skill")
            .exists());
    }

    #[test]
    fn uninstall_dry_run_lists_a_link_as_skip_and_never_as_remove() {
        let h = home();
        let (agents, _, _) = linked_agents_folder(h.path());
        let ran = uninstall(h.path(), false, true, true);
        assert_eq!(ran.code, 0, "{}", ran.err);
        let under_link = format!("remove {}", agents.join("openai.yaml").display());
        assert!(!ran.out.contains(&under_link), "{}", ran.out);
        assert!(
            ran.out
                .contains(&format!("skip {} (a link, left alone)", agents.display())),
            "{}",
            ran.out
        );
    }

    #[test]
    fn install_never_overwrites_a_file_behind_a_symlinked_agents_folder() {
        let h = home();
        let (agents, _, foreign_yaml) = linked_agents_folder(h.path());
        let ran = install(h.path(), false, true, false);
        assert_eq!(ran.code, 1);
        assert!(
            ran.err.contains(&agents.display().to_string()),
            "{}",
            ran.err
        );
        assert_eq!(
            read(&foreign_yaml),
            "user-authored config, never installed by vaakora"
        );
        assert!(agents.symlink_metadata().unwrap().file_type().is_symlink());
    }

    #[test]
    fn uninstall_dry_run_removes_nothing() {
        let h = home();
        install(h.path(), false, false, false);
        let ran = uninstall(h.path(), false, false, true);
        assert_eq!(ran.code, 0, "{}", ran.err);
        assert_eq!(ran.lines("remove").len(), 16, "{}", ran.out);
        assert_eq!(
            read(
                &h.path()
                    .join(".agents/skills/vaakora-read/agents/openai.yaml")
            ),
            file(Agent::Codex, "vaakora-read", "agents/openai.yaml")
        );
        assert!(h
            .path()
            .join(".claude/skills/vaakora-stop/.vaakora-skill")
            .exists());
    }

    #[test]
    fn uninstall_with_nothing_installed_does_nothing() {
        let h = home();
        let ran = uninstall(h.path(), false, false, false);
        assert_eq!(ran.code, 0, "{}", ran.err);
        assert!(ran.out.is_empty(), "{}", ran.out);
        assert!(!h.path().join(".claude").exists());
    }

    #[test]
    fn claude_only_flag() {
        let h = home();
        let ran = install(h.path(), true, false, false);
        assert_eq!(ran.code, 0, "{}", ran.err);
        assert_eq!(ran.lines("write").len(), 4);
        assert!(h
            .path()
            .join(".claude/skills/vaakora-read/SKILL.md")
            .exists());
        assert!(!h.path().join(".agents").exists());
    }

    #[test]
    fn codex_only_flag() {
        let h = home();
        let ran = install(h.path(), false, true, false);
        assert_eq!(ran.code, 0, "{}", ran.err);
        assert_eq!(ran.lines("write").len(), 6);
        assert!(h
            .path()
            .join(".agents/skills/vaakora-stop/agents/openai.yaml")
            .exists());
        assert!(!h.path().join(".claude").exists());
    }

    #[test]
    fn no_home_exits_1() {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let action = AgentAction::Install {
            claude: false,
            codex: false,
            dry_run: false,
        };
        assert_eq!(run_agent(action, None, &mut out, &mut err), 1);
        assert!(out.is_empty());
        assert_eq!(
            String::from_utf8(err).unwrap(),
            "vaakora: cannot find your home folder\n"
        );
    }

    #[test]
    fn a_symlinked_agents_folder_stops_the_install() {
        let h = home();
        install(h.path(), false, true, false);
        let elsewhere = h.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let agents = h.path().join(".agents/skills/vaakora-read/agents");
        std::fs::remove_dir_all(&agents).unwrap();
        symlink(&elsewhere, &agents).unwrap();
        let ran = install(h.path(), false, true, false);
        assert_eq!(ran.code, 1);
        assert!(
            ran.err.contains(&agents.display().to_string()),
            "{}",
            ran.err
        );
        assert!(!elsewhere.join("openai.yaml").exists());
    }

    #[test]
    fn remove_leaves_a_folder_that_gained_a_file_after_the_plan() {
        let h = home();
        let dir = h.path().join(".claude/skills/vaakora-read");
        put(&dir.join("notes.txt"), "mine");
        let steps = vec![Step::Remove(dir.clone())];
        apply(&steps).unwrap();
        assert_eq!(read(&dir.join("notes.txt")), "mine");
    }

    #[test]
    fn remove_of_something_already_gone_is_fine() {
        let h = home();
        apply(&[Step::Remove(h.path().join("gone"))]).unwrap();
    }

    #[test]
    fn skills_frontmatter_is_exact() {
        let read_description = "Read a file or the current plan aloud with Vaakora, the local text-to-speech app. Runs only when you invoke /vaakora-read.";
        assert_eq!(
            frontmatter(file(Agent::Claude, "vaakora-read", "SKILL.md")),
            pairs(&[
                ("name", "vaakora-read"),
                ("description", read_description),
                ("argument-hint", "\"[path]\""),
                ("disable-model-invocation", "true"),
                ("allowed-tools", "Bash(vaakora read *) Bash(vaakora status)"),
            ])
        );
        assert_eq!(
            frontmatter(file(Agent::Claude, "vaakora-stop", "SKILL.md")),
            pairs(&[
                ("name", "vaakora-stop"),
                (
                    "description",
                    "Stop Vaakora reading aloud. Runs only when you invoke /vaakora-stop."
                ),
                ("disable-model-invocation", "true"),
                ("allowed-tools", "Bash(vaakora stop)"),
            ])
        );
        assert_eq!(
            frontmatter(file(Agent::Codex, "vaakora-read", "SKILL.md")),
            pairs(&[
                ("name", "vaakora-read"),
                (
                    "description",
                    "Read a file or the current plan aloud with Vaakora, the local text-to-speech app. Use only when the user invokes $vaakora-read."
                ),
            ])
        );
        assert_eq!(
            frontmatter(file(Agent::Codex, "vaakora-stop", "SKILL.md")),
            pairs(&[
                ("name", "vaakora-stop"),
                (
                    "description",
                    "Stop Vaakora reading aloud. Use only when the user invokes $vaakora-stop."
                ),
            ])
        );
        for s in SKILLS.iter().filter(|s| s.agent == Agent::Codex) {
            let name = &frontmatter(file(Agent::Codex, s.name, "SKILL.md"))[0].1;
            assert_eq!(name, s.name, "the name equals the directory");
        }
    }

    #[test]
    fn codex_yaml_is_explicit_only() {
        assert_eq!(
            file(Agent::Codex, "vaakora-read", "agents/openai.yaml"),
            "interface:\n  display_name: \"Vaakora read aloud\"\n  short_description: \"Read a file or the current plan aloud with Vaakora\"\npolicy:\n  allow_implicit_invocation: false\n"
        );
        assert_eq!(
            file(Agent::Codex, "vaakora-stop", "agents/openai.yaml"),
            "interface:\n  display_name: \"Vaakora stop reading\"\n  short_description: \"Stop Vaakora reading aloud\"\npolicy:\n  allow_implicit_invocation: false\n"
        );
    }

    #[test]
    fn skills_run_no_command_before_the_model_sees_them() {
        // Claude Code's bang syntax runs a command when the skill loads (F9): none is used.
        for (name, text) in every_skill_text() {
            assert!(!text.contains("!`"), "{name} has a bang line");
        }
    }

    #[test]
    fn skills_never_pipe_text() {
        for (name, text) in every_skill_text() {
            assert!(!text.contains("<<"), "{name} has a here-document");
            assert!(!text.contains("echo "), "{name} has an echo");
        }
    }

    #[test]
    fn read_skills_write_conversation_text_to_a_file_outside_any_repository() {
        for agent in [Agent::Claude, Agent::Codex] {
            let text = file(agent, "vaakora-read", "SKILL.md");
            assert!(text.contains("`$XDG_RUNTIME_DIR`"), "{agent:?}");
            assert!(
                text.contains("(never inside a repository or the working directory)"),
                "{agent:?}"
            );
            assert!(
                text.contains("delete the file once the command exits 0"),
                "{agent:?}"
            );
            assert!(
                text.contains("Never put the text itself on a command line or in a here-document"),
                "{agent:?}"
            );
        }
    }

    #[test]
    fn skills_have_no_em_dash() {
        for (name, text) in every_skill_text() {
            assert!(!text.contains('\u{2014}'), "{name}");
        }
    }

    #[test]
    fn explicit_only_in_every_skill() {
        for s in SKILLS {
            match s.agent {
                Agent::Claude => assert!(
                    file(s.agent, s.name, "SKILL.md")
                        .contains("\ndisable-model-invocation: true\n"),
                    "{}",
                    s.name
                ),
                Agent::Codex => assert!(
                    file(s.agent, s.name, "agents/openai.yaml")
                        .contains("\n  allow_implicit_invocation: false\n"),
                    "{}",
                    s.name
                ),
            }
        }
    }
}
