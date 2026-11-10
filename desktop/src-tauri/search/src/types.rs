//! The search contract, as `src/lib/search/types.ts` defines it: what the console shows.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NodeKind {
    Account,
    Group,
    Project,
    Service,
    Device,
    Step,
    AccountSecret,
    Note,
    ProjectSecret,
    File,
}

impl NodeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            NodeKind::Account => "account",
            NodeKind::Group => "group",
            NodeKind::Project => "project",
            NodeKind::Service => "service",
            NodeKind::Device => "device",
            NodeKind::Step => "step",
            NodeKind::AccountSecret => "account-secret",
            NodeKind::Note => "note",
            NodeKind::ProjectSecret => "project-secret",
            NodeKind::File => "file",
        }
    }
}

/// One record of the vault, as search shows it. Never a secret value.
#[derive(Clone, Debug, Serialize)]
pub struct SearchNode {
    /// `kind:id`, e.g. "account:12"; a group's id is its name.
    pub id: String,
    pub kind: NodeKind,
    pub title: String,
    pub subtitle: String,
    /// Where opening it goes.
    pub to: String,
    /// The device kind or sign-in step kind, for its icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// A hop on the way to a result: the record, and how it relates to the one before.
#[derive(Clone, Debug, Serialize)]
pub struct PathStep {
    pub node: SearchNode,
    pub via: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SearchHit {
    pub node: SearchNode,
    /// 0 to 1, comparable within one response only.
    pub score: f32,
    /// From the record the question named, to this one. Just [node] when it was named itself.
    pub path: Vec<PathStep>,
    /// It is the kind of thing asked for, or one of the best matches.
    pub answer: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Want {
    pub label: &'static str,
    pub words: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AnchorWords {
    pub words: String,
    pub nodes: Vec<SearchNode>,
}

/// How the question was read, shown above the results.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Understood {
    pub wants: Vec<Want>,
    pub anchors: Vec<AnchorWords>,
    pub unmatched: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SearchResponse {
    pub query: String,
    pub understood: Understood,
    pub hits: Vec<SearchHit>,
}
