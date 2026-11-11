//! The vault as a graph: every record a node, every relation an edge both ways, each
//! direction with its own wording ("uses account" / "used by"). Built from metadata
//! only; no secret value is ever part of it. A port of `src/lib/search/graph.ts`.

use std::collections::HashMap;

use crate::{
    text::words,
    types::{NodeKind, SearchNode},
    vault::{LinkKind, Vault, device_name, step_name},
};

/// A word a node can be found by; names weigh more than emails or descriptions.
#[derive(Clone, Debug)]
pub struct Term {
    pub text: String,
    pub weight: f64,
}

#[derive(Clone, Debug)]
pub struct Node {
    pub node: SearchNode,
    pub terms: Vec<Term>,
    /// One sentence about the record, for the embedder and the reranker.
    pub text: String,
}

#[derive(Clone, Copy, Debug)]
pub struct Edge {
    pub to: usize,
    /// How `to` relates to the node the edge leaves: "lives on", "uses account"…
    pub via: &'static str,
}

#[derive(Debug, Default)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Vec<Edge>>,
    index: HashMap<String, usize>,
}

impl Graph {
    pub fn find(&self, id: &str) -> Option<usize> {
        self.index.get(id).copied()
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    fn add(&mut self, node: SearchNode, terms: Vec<Term>, text: String) {
        self.index.insert(node.id.clone(), self.nodes.len());
        self.nodes.push(Node { node, terms, text });
        self.edges.push(Vec::new());
    }

    fn add_terms(&mut self, id: &str, extra: Vec<Term>) {
        if let Some(i) = self.find(id) {
            self.nodes[i].terms.extend(extra);
        }
    }

    /// Both directions, each with its own wording.
    fn link(&mut self, from: &str, to: &str, forward: &'static str, back: &'static str) {
        let (Some(a), Some(b)) = (self.find(from), self.find(to)) else { return };
        if a == b {
            return;
        }
        self.edges[a].push(Edge { to: b, via: forward });
        self.edges[b].push(Edge { to: a, via: back });
    }
}

fn terms(text: &str, weight: f64) -> Vec<Term> {
    words(text).into_iter().map(|text| Term { text, weight }).collect()
}

fn node(id: String, kind: NodeKind, title: &str, subtitle: String, to: String, detail: Option<&str>) -> SearchNode {
    SearchNode { id, kind, title: title.to_owned(), subtitle, to, detail: detail.map(str::to_owned) }
}

/// "https://coolify.acme.dev/x" → "coolify.acme.dev"
fn host(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    rest.split(['/', '?', '#']).next().unwrap_or(rest)
}

fn joined(parts: &[&str]) -> String {
    parts.iter().filter(|p| !p.trim().is_empty()).copied().collect::<Vec<_>>().join(", ")
}

pub fn build(vault: &Vault) -> Graph {
    let mut g = Graph::default();
    let account_name: HashMap<i64, &str> = vault.accounts.iter().map(|a| (a.id, a.domain_name.as_str())).collect();
    let project_name: HashMap<i64, &str> = vault.projects.iter().map(|p| (p.id, p.name.as_str())).collect();
    let device_title: HashMap<i64, &str> = vault.devices.iter().map(|d| (d.id, d.name.as_str())).collect();
    let service_name: HashMap<i64, &str> = vault.services.iter().map(|s| (s.id, s.name.as_str())).collect();

    for a in &vault.accounts {
        let subtitle = match a.username.as_deref() {
            Some(u) if !u.is_empty() => format!("{}, {u}", a.email),
            _ => a.email.clone(),
        };
        let mut t = terms(&a.domain_name, 1.0);
        t.extend(terms(a.username.as_deref().unwrap_or(""), 0.8));
        t.extend(terms(&a.email, 0.6));
        let text = format!("{}: {} account, {}", a.domain_name, a.group, joined(&[a.username.as_deref().unwrap_or(""), &a.email]));
        g.add(node(format!("account:{}", a.id), NodeKind::Account, &a.domain_name, subtitle, format!("/accounts/{}", a.id), None), t, text);
    }

    // Groups, in order of first appearance (as a JS Map keeps them).
    let mut groups: Vec<(&str, Vec<i64>)> = Vec::new();
    for a in &vault.accounts {
        match groups.iter_mut().find(|(name, _)| *name == a.group) {
            Some((_, members)) => members.push(a.id),
            None => groups.push((&a.group, vec![a.id])),
        }
    }
    for (name, members) in &groups {
        let subtitle = format!("{} account{}", members.len(), if members.len() == 1 { "" } else { "s" });
        let examples: Vec<&str> = members.iter().take(6).filter_map(|id| account_name.get(id).copied()).collect();
        let text = format!("{name}: group of accounts such as {}", examples.join(", "));
        g.add(node(format!("group:{name}"), NodeKind::Group, name, subtitle, "/accounts".into(), None), terms(name, 0.9), text);
        for id in members {
            g.link(&format!("group:{name}"), &format!("account:{id}"), "includes", "in group");
        }
    }

    for p in &vault.projects {
        let subtitle = if p.description.is_empty() { "Project".to_owned() } else { p.description.clone() };
        let mut t = terms(&p.name, 1.0);
        t.extend(terms(&p.description, 0.5));
        let text = format!("{}: project. {}", p.name, p.description);
        g.add(node(format!("project:{}", p.id), NodeKind::Project, &p.name, subtitle, format!("/projects/{}", p.id), None), t, text.trim().to_owned());
    }

    for s in &vault.services {
        let project = project_name.get(&s.project_id).copied();
        let subtitle = format!("Service in {}", project.unwrap_or("a project"));
        let mut t = terms(&s.name, 1.0);
        t.extend(terms(&s.url, 0.7));
        // Its own logins: "root prod" finds the server whose root user it is.
        for login in &s.logins {
            t.extend(terms(&login.username, 0.6));
            t.extend(terms(&login.note, 0.5));
        }
        let mut text = format!("{}: service of the project {}", s.name, project.unwrap_or("?"));
        if !s.url.is_empty() {
            text += &format!(", at {}", host(&s.url));
        }
        for (id, role) in s.uses() {
            if let Some(account) = account_name.get(&id) {
                text += &format!(", signed in with the {account} account");
                if !role.is_empty() {
                    text += &format!(" ({role})");
                }
            }
        }
        g.add(
            node(format!("service:{}", s.id), NodeKind::Service, &s.name, subtitle, format!("/projects/{}?show=services", s.project_id), None),
            t,
            text,
        );
    }

    for d in &vault.devices {
        let kind = device_name(&d.kind);
        let mut t = terms(&d.name, 1.0);
        t.extend(terms(&d.notes, 0.5));
        let text = format!("{}: {}. {}", d.name, kind.to_lowercase(), d.notes);
        g.add(
            node(format!("device:{}", d.id), NodeKind::Device, &d.name, kind.to_owned(), format!("/devices?open={}", d.id), Some(&d.kind)),
            t,
            text.trim().to_owned(),
        );
    }

    for f in &vault.factors {
        let name = step_name(&f.kind);
        let owner = account_name.get(&f.account_id).copied().unwrap_or("an account");
        let subtitle = if f.label.is_empty() { format!("For {owner}") } else { format!("{}, for {owner}", f.label) };
        let mut t = terms(name, 0.8);
        t.extend(terms(&f.label, 0.9));
        let mut text = format!("{name} to sign in to {owner}");
        if !f.label.is_empty() {
            text += &format!(" ({})", f.label);
        }
        if let Some(device) = f.device_id.and_then(|id| device_title.get(&id)) {
            text += &format!(", on the {device}");
        }
        g.add(node(format!("step:{}", f.id), NodeKind::Step, name, subtitle, format!("/accounts/{}", f.account_id), Some(&f.kind)), t, text);
    }

    for s in &vault.account_secrets {
        let note = s.kind == "note";
        let kind = if note { NodeKind::Note } else { NodeKind::AccountSecret };
        let owner = account_name.get(&s.account_id).copied().unwrap_or("an account");
        let subtitle = format!("{} in {owner}", if note { "Note" } else { "Secret" });
        let text = format!("{}: {} kept with the {owner} account", s.name, if note { "note" } else { "secret" });
        g.add(
            node(format!("{}:{}", kind.as_str(), s.id), kind, &s.name, subtitle, format!("/accounts/{}?show=secrets", s.account_id), None),
            terms(&s.name, 1.0),
            text,
        );
    }

    for s in &vault.secrets {
        let file = s.kind == "file";
        let kind = if file { NodeKind::File } else { NodeKind::ProjectSecret };
        let project = project_name.get(&s.project_id).copied().unwrap_or("a project");
        let subtitle = format!("{} in {project}", if file { "File" } else { "Secret" });
        // What it does first (its description), then what it is called and where.
        let mut text = if s.description.trim().is_empty() {
            String::new()
        } else {
            format!("{}. ", s.description.trim())
        };
        text += &format!("{}, {} of the project {project}", s.name, if file { "file" } else { "secret" });
        if let Some(service) = s.service_id.and_then(|id| service_name.get(&id)) {
            text += &format!(", for {service}");
        }
        let to = format!("/projects/{}?show={}", s.project_id, if file { "files" } else { "secrets" });
        // Its description too: "the root ssh key" finds id_ed25519 described that way.
        let mut t = terms(&s.name, 1.0);
        t.extend(terms(&s.description, 0.5));
        g.add(node(format!("{}:{}", kind.as_str(), s.id), kind, &s.name, subtitle, to, None), t, text);
    }

    // Relations, worded from each side.
    for l in &vault.links {
        let (a, b) = (format!("account:{}", l.account_id), format!("account:{}", l.linked_account_id));
        match l.kind {
            LinkKind::SignIn => g.link(&a, &b, "signs in with", "used to sign in to"),
            LinkKind::Recovery => g.link(&a, &b, "recovered by", "recovers"),
        }
    }
    for f in &vault.factors {
        g.link(&format!("account:{}", f.account_id), &format!("step:{}", f.id), "second step", "protects");
        if let Some(device) = f.device_id {
            g.link(&format!("step:{}", f.id), &format!("device:{device}"), "lives on", "holds");
        }
    }
    for l in &vault.device_links {
        let (account, device) = (format!("account:{}", l.account_id), format!("device:{}", l.device_id));
        g.link(&account, &device, "signed in on", "signed in to");
        // What it does there ("authenticator") names both ends a little.
        g.add_terms(&account, terms(&l.note, 0.5));
        g.add_terms(&device, terms(&l.note, 0.5));
    }
    for s in &vault.account_secrets {
        let kind = if s.kind == "note" { "note" } else { "account-secret" };
        g.link(&format!("account:{}", s.account_id), &format!("{kind}:{}", s.id), "keeps", "kept with");
    }
    for s in &vault.services {
        g.link(&format!("project:{}", s.project_id), &format!("service:{}", s.id), "has service", "in project");
        // Every account it uses ("coolify account" finds them all), and the role each
        // has there as a word of that account ("coolify admin" finds the admin one).
        for (account, role) in s.uses() {
            g.link(&format!("service:{}", s.id), &format!("account:{account}"), "uses account", "used by");
            g.add_terms(&format!("account:{account}"), terms(role, 0.7));
        }
    }
    for s in &vault.secrets {
        let id = format!("{}:{}", if s.kind == "file" { "file" } else { "project-secret" }, s.id);
        g.link(&format!("project:{}", s.project_id), &id, "keeps", "in project");
        if let Some(service) = s.service_id {
            g.link(&format!("service:{service}"), &id, "uses", "for service");
        }
    }
    g
}
