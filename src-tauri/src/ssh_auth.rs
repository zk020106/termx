//! SSH 认证：密码、私钥、私钥加口令、SSH Agent、键盘交互（二次验证）。
//!
//! 设计要点：
//! - **凭据只在内存里**。`Credential` 活到认证结束就地丢弃，密码与私钥口令不写进任何配置文件；
//!   私钥**只读路径**，不复制、不缓存私钥材料（`Credential` 的 `Debug` 也做了脱敏，
//!   避免哪天被打进日志）。
//! - **Agent 认证**走 `authenticate_publickey_with`：公钥交给服务器，签名交给 ssh-agent 完成。
//!   russh 0.63 已经为 `AgentClient` 实现了 `Signer`（在 russh 自己的 `src/auth.rs` 里），
//!   所以这里不需要自己再包一层 Signer，用 `dynamic()` 把各平台的流收敛成一个类型即可。
//!   私钥材料始终留在 agent 进程里，TermX 只拿到公钥与签名。
//! - **键盘交互可能来回多轮**（先密码、再验证码）：每一轮都用 `ssh://auth-prompt/{key}`
//!   事件问界面，再用 `oneshot` 等这次回答。轮数与等待时间都有上限，
//!   免得服务器异常时无限循环、或者用户关掉弹窗后任务永远挂着。
//! - **失败要说人话**：文件不存在 / 口令错 / 格式不支持 / agent 里没身份 / agent 没运行，
//!   各给各的下一步动作，不笼统甩一句「认证失败」。

use crate::known_hosts;
use crate::ssh::{emit_phase, emit_phase_opt, SshState};
use russh::client::{AuthResult, Handle, KeyboardInteractiveAuthResponse, Prompt};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::{ssh_key, Algorithm, Error as KeysError, HashAlg, PrivateKeyWithHashAlg};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

/// 键盘交互最多问这么多轮。正常的多因素认证也就 2~3 轮，
/// 到 10 轮还没完基本可以判定服务器行为异常。
const MAX_KI_ROUNDS: usize = 10;

/// 单轮等待界面输入的上限：用户一直不答（或弹窗被关掉）时不能把会话任务钉死。
const PROMPT_TIMEOUT: Duration = Duration::from_secs(300);

/// 前端传进来的凭据，用 `method` 做 tag：
/// - `{"method":"password","password":"..."}`
/// - `{"method":"private_key","path":"C:/Users/x/.ssh/id_ed25519","passphrase":null}`
/// - `{"method":"agent"}`
/// - `{"method":"keyboard_interactive"}`
/// - `{"method":"ask_password"}`：跳板机等没有现成密码的一跳，连接时再弹框问
/// - `{"method":"ask_passphrase","path":"..."}`：带口令的私钥，口令连接时再问
#[derive(Clone, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum Credential {
    Password {
        password: String,
    },
    PrivateKey {
        path: String,
        /// 私钥口令。前端在「没有口令」时传 null，字段整个缺省也按「没有口令」处理
        #[serde(default)]
        passphrase: Option<String>,
    },
    Agent,
    KeyboardInteractive,
    /// 连接到这一跳时再向用户要密码（经 `ssh://auth-prompt/{key}`，与键盘交互同一个输入框）
    AskPassword,
    /// 连接到这一跳时再向用户要私钥口令
    AskPassphrase {
        path: String,
    },
}

/// 手写 `Debug`：凭据有可能被顺手打进日志，密码与口令绝不能在日志里出现。
impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Credential::Password { .. } => f.write_str("Password { password: <已隐藏> }"),
            Credential::PrivateKey { path, passphrase } => f
                .debug_struct("PrivateKey")
                .field("path", path)
                .field("passphrase", &passphrase.as_ref().map(|_| "<已隐藏>"))
                .finish(),
            Credential::Agent => f.write_str("Agent"),
            Credential::KeyboardInteractive => f.write_str("KeyboardInteractive"),
            Credential::AskPassword => f.write_str("AskPassword"),
            Credential::AskPassphrase { path } => f.debug_struct("AskPassphrase").field("path", path).finish(),
        }
    }
}

/// 给界面展示的 agent 身份。**只有公钥信息**，不含任何私钥材料。
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct AgentIdentityInfo {
    pub fingerprint: String,
    pub comment: String,
    pub algorithm: String,
}

/// `ssh://auth-prompt/{key}` 事件里的一个输入项。
/// `echo: false` 表示这是密码类输入，界面必须按密码框渲染。
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
struct AuthPromptItem {
    prompt: String,
    echo: bool,
}

/// `ssh://auth-prompt/{key}` 事件的载荷
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
struct AuthPromptPayload {
    name: String,
    instructions: String,
    prompts: Vec<AuthPromptItem>,
}

/// 一次键盘交互应答：`Ok(..)` 是界面提交的内容，`Err(..)` 是取消或超时的原因
type AuthAnswers = Result<Vec<String>, String>;

/// 等待界面回答的通道表：会话 key -> 一次性发送端
type PromptWaiters = Arc<Mutex<HashMap<String, oneshot::Sender<AuthAnswers>>>>;

/// 正在等界面回答的键盘交互请求。
///
/// 注册在 `SshState` 里，`ssh_auth_respond` 靠它把答案送回正在认证的那个会话任务。
/// 内部是 `Arc<Mutex<..>>`，所以可以 clone 一份交给后台任务。
#[derive(Default, Clone)]
pub struct AuthPromptRegistry {
    waits: PromptWaiters,
}

impl AuthPromptRegistry {
    /// 登记一次「等你回答」，返回等待用的接收端
    fn register(&self, key: &str) -> Result<oneshot::Receiver<AuthAnswers>, String> {
        let (tx, rx) = oneshot::channel();
        let mut waits = self.waits.lock().map_err(|_| "认证输入表已损坏".to_string())?;
        // 同 key 上一轮的通道若还在，直接顶掉（旧接收端早已结束）
        waits.insert(key.to_string(), tx);
        Ok(rx)
    }

    fn take(&self, key: &str) -> Option<oneshot::Sender<AuthAnswers>> {
        self.waits.lock().ok()?.remove(key)
    }

    /// 界面提交了一次应答
    pub fn resolve(&self, key: &str, responses: Vec<String>) -> Result<(), String> {
        let tx = self
            .take(key)
            .ok_or_else(|| "当前没有等待输入的认证请求".to_string())?;
        tx.send(Ok(responses))
            .map_err(|_| "认证请求已失效（会话可能已经结束）".to_string())
    }

    /// 会话结束 / 用户取消：让等待中的认证流程立刻醒过来，而不是等到超时
    pub fn cancel(&self, key: &str, reason: &str) {
        if let Some(tx) = self.take(key) {
            let _ = tx.send(Err(reason.to_string()));
        }
    }
}

/// 按凭据分派认证，并把 `auth` 阶段（用了哪种方式、结果如何）回报给界面。
///
/// 成功返回 `Ok(())`；失败返回给用户看的文案 —— 文案在返回之前已经作为
/// `auth` 阶段发过一次，调用方直接把它当错误往上抛即可。
pub async fn authenticate<H: russh::client::Handler>(
    app: &AppHandle,
    key: &str,
    session: &mut Handle<H>,
    username: &str,
    credential: &Credential,
    prompts: &AuthPromptRegistry,
) -> Result<(), String> {
    authenticate_as(app, key, "auth", None, session, username, credential, prompts).await
}

/// 与 [`authenticate`] 相同，但阶段名与说明前缀可定制：
/// 跳板机的认证记在 `tcp` 阶段并带上「跳板机 1/2 xxx：」前缀，
/// 免得界面上「认证」这一步在目标主机握手之前就被标成完成。
#[allow(clippy::too_many_arguments)]
pub async fn authenticate_as<H: russh::client::Handler>(
    app: &AppHandle,
    key: &str,
    phase: &str,
    prefix: Option<&str>,
    session: &mut Handle<H>,
    username: &str,
    credential: &Credential,
    prompts: &AuthPromptRegistry,
) -> Result<(), String> {
    let label = |detail: &str| match prefix {
        Some(p) => format!("{p}：{detail}"),
        None => detail.to_string(),
    };
    // 「连接时再问」的凭据：先问到具体的密码 / 口令（正常流程里调用方已经换好了）
    let resolved;
    let credential = match credential {
        Credential::AskPassword | Credential::AskPassphrase { .. } => {
            match resolve_credential(app, key, prompts, credential.clone(), username, username, phase).await {
                Ok(c) => {
                    resolved = c;
                    &resolved
                }
                Err(detail) => {
                    emit_phase(app, key, phase, false, label(&detail));
                    return Err(detail);
                }
            }
        }
        other => other,
    };
    let result = match credential {
        Credential::Password { password } => password_auth(session, username, password).await,
        Credential::PrivateKey { path, passphrase } => {
            private_key_auth(session, username, path, passphrase.as_deref()).await
        }
        Credential::Agent => agent_auth(session, username).await,
        Credential::KeyboardInteractive => {
            keyboard_interactive_auth(Some(app), key, session, username, prompts).await
        }
        Credential::AskPassword | Credential::AskPassphrase { .. } => {
            unreachable!("上面已经换成具体凭据")
        }
    };

    match &result {
        Ok(detail) => emit_phase(app, key, phase, true, label(detail)),
        // 跳板机认证失败的那一条由调用方作为 failed 阶段报出，这里不再提前把 tcp 标红
        Err(detail) if prefix.is_none() => emit_phase(app, key, phase, false, detail.clone()),
        Err(_) => {}
    }
    result.map(|_| ())
}

/// 把「连接时再问」的凭据换成具体凭据：经认证输入框向用户要密码 / 口令。
/// `who` 是给人看的这一跳的名字（例如「跳板机 1/2 bastion:22」）。
pub async fn resolve_credential(
    app: &AppHandle,
    key: &str,
    prompts: &AuthPromptRegistry,
    credential: Credential,
    who: &str,
    username: &str,
    phase: &str,
) -> Result<Credential, String> {
    match credential {
        Credential::AskPassword => {
            emit_phase(app, key, phase, true, format!("{who}：等待输入 {username} 的密码"));
            let items = [Prompt {
                prompt: format!("{username} 的密码："),
                echo: false,
            }];
            let mut answers = ask_user(Some(app), key, prompts, who, "这一跳没有保存密码，请输入后继续连接。", &items).await?;
            Ok(Credential::Password {
                password: answers.pop().unwrap_or_default(),
            })
        }
        Credential::AskPassphrase { path } => {
            emit_phase(app, key, phase, true, format!("{who}：等待输入私钥口令"));
            let items = [Prompt {
                prompt: format!("私钥 {} 的口令：", display_path(&path)),
                echo: false,
            }];
            let mut answers = ask_user(Some(app), key, prompts, who, "这把私钥有口令保护，请输入后继续连接。", &items).await?;
            let passphrase = answers.pop().filter(|p| !p.is_empty());
            Ok(Credential::PrivateKey { path, passphrase })
        }
        other => Ok(other),
    }
}

/// 密码认证
async fn password_auth<H: russh::client::Handler>(
    session: &mut Handle<H>,
    username: &str,
    password: &str,
) -> Result<String, String> {
    let result = session
        .authenticate_password(username, password)
        .await
        .map_err(|e| format!("提交密码认证失败：{e}"))?;

    match result {
        AuthResult::Success => Ok(format!("{username} 密码认证通过")),
        AuthResult::Failure { partial_success, .. } if partial_success => Err(
            "密码已通过，但服务器还要求继续验证（多因素）。\
             请改用「键盘交互」方式连接，才能完成二次验证。"
                .to_string(),
        ),
        AuthResult::Failure {
            remaining_methods, ..
        } => Err(format!(
            "密码认证被拒绝：用户名或密码不正确。服务器接受的方式：{}",
            methods_text(&remaining_methods)
        )),
    }
}

/// 私钥认证（含带口令的私钥：口令在这里解开私钥，解不开就报错，绝不静默降级）
async fn private_key_auth<H: russh::client::Handler>(
    session: &mut Handle<H>,
    username: &str,
    path: &str,
    passphrase: Option<&str>,
) -> Result<String, String> {
    let private = load_private_key(path, passphrase)?;
    let public = private.public_key().clone();
    let shown = display_path(path);
    let algorithm = public.algorithm().to_string();
    let fingerprint = known_hosts::fingerprint_of(&public);

    let hash_alg = rsa_hash_alg(session, public.algorithm()).await;
    let key = PrivateKeyWithHashAlg::new(Arc::new(private), hash_alg);

    let result = session
        .authenticate_publickey(username, key)
        .await
        .map_err(|e| format!("提交私钥认证失败：{e}"))?;

    match result {
        AuthResult::Success => Ok(format!("私钥 {shown}（{algorithm} {fingerprint}）认证通过")),
        AuthResult::Failure { partial_success, .. } if partial_success => Err(format!(
            "私钥 {shown} 已通过，但服务器还要求继续验证（多因素）。\
             请改用「键盘交互」方式连接，才能完成二次验证。"
        )),
        AuthResult::Failure {
            remaining_methods, ..
        } => Err(format!(
            "私钥 {shown} 被服务器拒绝：这把公钥可能没有加到服务器的 authorized_keys 里。\
             服务器接受的方式：{}",
            methods_text(&remaining_methods)
        )),
    }
}

/// SSH Agent 认证：把 agent 里的身份逐个拿去试，签名由 agent 完成。
async fn agent_auth<H: russh::client::Handler>(
    session: &mut Handle<H>,
    username: &str,
) -> Result<String, String> {
    let (mut agent, agent_name) = connect_agent().await?;

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| format!("从{agent_name}读取身份列表失败：{e}"))?;
    if identities.is_empty() {
        return Err(format!(
            "SSH Agent 里没有可用身份：请先 ssh-add 你的私钥（当前 agent：{agent_name}）。"
        ));
    }

    let mut rejected: Vec<String> = Vec::new();
    for identity in &identities {
        let public = identity.public_key().into_owned();
        let fingerprint = known_hosts::fingerprint_of(&public);
        let hash_alg = rsa_hash_alg(session, public.algorithm()).await;

        let result = match identity {
            AgentIdentity::PublicKey { .. } => {
                session
                    .authenticate_publickey_with(username, public.clone(), hash_alg, &mut agent)
                    .await
            }
            AgentIdentity::Certificate { certificate, .. } => {
                session
                    .authenticate_certificate_with(username, certificate.clone(), hash_alg, &mut agent)
                    .await
            }
        };

        match result {
            Ok(AuthResult::Success) => {
                return Ok(format!(
                    "SSH Agent 身份 {fingerprint}（{agent_name}）认证通过"
                ));
            }
            Ok(AuthResult::Failure { partial_success, .. }) if partial_success => {
                return Err(format!(
                    "SSH Agent 身份 {fingerprint} 已通过，但服务器还要求继续验证（多因素）。\
                     请改用「键盘交互」方式连接，才能完成二次验证。"
                ));
            }
            Ok(AuthResult::Failure { .. }) => rejected.push(fingerprint),
            Err(e) => {
                return Err(format!("SSH Agent 签名失败（{agent_name}）：{e}"));
            }
        }
    }

    Err(format!(
        "SSH Agent 里的 {} 个身份都被服务器拒绝：{}。\
         请确认这些公钥已经加到服务器的 authorized_keys 里。",
        rejected.len(),
        rejected.join("、")
    ))
}

/// 键盘交互认证（二次验证码通常走这条路）。
///
/// 服务器每一轮的提问都转成 `ssh://auth-prompt/{key}` 事件问界面，
/// 界面提交后调 `ssh_auth_respond` 送回答案，然后继续下一轮，直到 Success / Failure。
async fn keyboard_interactive_auth<H: russh::client::Handler>(
    app: Option<&AppHandle>,
    key: &str,
    session: &mut Handle<H>,
    username: &str,
    prompts: &AuthPromptRegistry,
) -> Result<String, String> {
    let mut response = session
        .authenticate_keyboard_interactive_start(username, None)
        .await
        .map_err(|e| format!("发起键盘交互认证失败：{e}"))?;

    let mut round = 0usize;
    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => {
                return Ok(if round == 0 {
                    "键盘交互认证通过".to_string()
                } else {
                    format!("键盘交互认证通过（服务器共询问 {round} 轮）")
                });
            }
            KeyboardInteractiveAuthResponse::Failure {
                partial_success, ..
            } if partial_success => {
                return Err(
                    "键盘交互这一种方式已通过，但服务器还要求用另一种方式继续验证。\
                     TermX 一次连接只用一种认证方式，请改用服务器要求的另一种方式重连。"
                        .to_string(),
                );
            }
            KeyboardInteractiveAuthResponse::Failure {
                remaining_methods,
                ..
            } => {
                // round == 0 表示服务器自始至终没发过一次提问：那不是「输入错了」，
                // 而是它压根没启用键盘交互这种方式。归因写反会把用户引到错误的方向。
                return Err(if round == 0 {
                    format!(
                        "服务器没有发起任何交互提问，说明它未启用键盘交互认证（sshd 侧 KbdInteractiveAuthentication）。\
                         本次连接没有向服务器提交过任何输入。它接受的方式：{}",
                        methods_text(&remaining_methods)
                    )
                } else {
                    format!(
                        "键盘交互认证被拒绝：第 {round} 轮的回答没通过。服务器接受的方式：{}",
                        methods_text(&remaining_methods)
                    )
                });
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts: items,
            } => {
                round += 1;
                if round > MAX_KI_ROUNDS {
                    return Err(format!(
                        "键盘交互连续问了 {MAX_KI_ROUNDS} 轮还没结束，已中止（服务器行为异常）。"
                    ));
                }

                // 如实带上 echo：echo=false 的是密码类输入，界面要按密码框渲染
                let secret_count = items.iter().filter(|p| !p.echo).count();
                let secret_note = if secret_count > 0 {
                    format!("，其中 {secret_count} 项为密码输入")
                } else {
                    String::new()
                };
                emit_phase_opt(
                    app,
                    key,
                    "auth",
                    true,
                    format!(
                        "键盘交互（第 {round} 轮）：服务器要求 {} 项输入{secret_note}",
                        items.len()
                    ),
                );

                let answers = ask_user(app, key, prompts, &name, &instructions, &items).await?;
                response = session
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(|e| format!("提交键盘交互应答失败：{e}"))?;
            }
        }
    }
}

/// 把这一轮的提问发给界面，并等它回答。
///
/// `app` 为 `None` 时不发事件 —— 只给测试用：测试直接在 registry 侧作答，
/// 从而能验证「登记等待 → 投递提问 → 等到回答」这条往返，不需要真的起界面。
async fn ask_user(
    app: Option<&AppHandle>,
    key: &str,
    prompts: &AuthPromptRegistry,
    name: &str,
    instructions: &str,
    items: &[Prompt],
) -> Result<Vec<String>, String> {
    let receiver = prompts.register(key)?;

    let payload = AuthPromptPayload {
        name: name.to_string(),
        instructions: instructions.to_string(),
        prompts: items
            .iter()
            .map(|p| AuthPromptItem {
                prompt: p.prompt.clone(),
                echo: p.echo,
            })
            .collect(),
    };

    if let Some(app) = app {
        if let Err(error) = app.emit(&format!("ssh://auth-prompt/{key}"), payload) {
            // 事件发不出去就没人能回答，赶紧把登记撤掉，别留下一个永远等不到的通道
            prompts.cancel(key, "无法把输入请求发给界面");
            return Err(format!("无法把认证输入请求发给界面：{error}"));
        }
    }

    match tokio::time::timeout(PROMPT_TIMEOUT, receiver).await {
        Ok(Ok(Ok(responses))) => {
            if responses.len() != items.len() {
                return Err(format!(
                    "认证应答数量不对：服务器问了 {} 项，界面回了 {} 项",
                    items.len(),
                    responses.len()
                ));
            }
            Ok(responses)
        }
        Ok(Ok(Err(reason))) => Err(format!("认证输入已取消：{reason}")),
        Ok(Err(_)) => Err("认证输入通道已断开（会话可能已经结束）".to_string()),
        Err(_) => {
            prompts.cancel(key, "等待输入超时");
            Err(format!(
                "等待认证输入超过 {} 分钟，已中止本次连接",
                PROMPT_TIMEOUT.as_secs() / 60
            ))
        }
    }
}

/// 界面提交键盘交互应答
#[tauri::command]
pub fn ssh_auth_respond(
    state: State<'_, SshState>,
    key: String,
    responses: Vec<String>,
) -> Result<(), String> {
    state.auth_prompts.resolve(&key, responses)
}

/// 列出 SSH Agent 里可用的身份，供界面展示 / 让用户挑一把。
///
/// 返回空列表表示 agent 连上了但里面没有身份（提示用户 `ssh-add`）；
/// agent 压根没运行时会直接返回可操作的错误文案。
#[tauri::command]
pub async fn ssh_agent_identities() -> Result<Vec<AgentIdentityInfo>, String> {
    let (mut agent, agent_name) = connect_agent().await?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| format!("从{agent_name}读取身份列表失败：{e}"))?;
    Ok(identities.iter().map(identity_info).collect())
}

fn identity_info(identity: &AgentIdentity) -> AgentIdentityInfo {
    let key = identity.public_key();
    AgentIdentityInfo {
        fingerprint: known_hosts::fingerprint_of(&key),
        comment: identity.comment().to_string(),
        algorithm: key.algorithm().to_string(),
    }
}

/// 统一的 agent 客户端类型：把各平台的流（Windows 命名管道 / Pageant、Unix 套接字）
/// 收敛成一个具体类型，才能交给 `authenticate_publickey_with`。
///
/// russh 0.63 已经为 `AgentClient<R>` 实现了 `Signer`，所以 `dynamic()` 之后
/// 这个别名本身就满足 `Signer` 约束，不必再自己包一层。
pub type BoxedAgent = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

#[cfg(windows)]
const OPENSSH_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

/// 连上本机的 SSH agent（Windows：先试 OpenSSH 的命名管道，再退到 Pageant）
#[cfg(windows)]
async fn connect_agent() -> Result<(BoxedAgent, String), String> {
    let mut problems: Vec<String> = Vec::new();

    match AgentClient::connect_named_pipe(OPENSSH_AGENT_PIPE).await {
        Ok(client) => return Ok((client.dynamic(), "Windows OpenSSH 代理".to_string())),
        Err(e) => problems.push(format!("OpenSSH 代理（{OPENSSH_AGENT_PIPE}）：{e}")),
    }

    match AgentClient::connect_pageant().await {
        Ok(client) => return Ok((client.dynamic(), "Pageant".to_string())),
        Err(e) => problems.push(format!("Pageant：{e}")),
    }

    Err(format!(
        "SSH Agent 没有运行：两种连接方式都失败了（{}）。\
         请在「服务」里把 OpenSSH Authentication Agent 设为自动并启动；\
         用 PuTTY 的话也可以先启动 Pageant。",
        problems.join("；")
    ))
}

/// 连上本机的 SSH agent（Unix：走 SSH_AUTH_SOCK 指定的套接字）
#[cfg(not(windows))]
async fn connect_agent() -> Result<(BoxedAgent, String), String> {
    match AgentClient::connect_env().await {
        Ok(client) => Ok((client.dynamic(), "SSH_AUTH_SOCK".to_string())),
        Err(KeysError::EnvVar(name)) => Err(format!(
            "SSH Agent 没有运行：环境变量 {name} 不存在。\
             请先启动 ssh-agent，例如 eval \"$(ssh-agent -s)\"。"
        )),
        Err(KeysError::BadAuthSock) => Err(
            "SSH Agent 没有运行：SSH_AUTH_SOCK 指向的套接字不存在（agent 可能已经退出）。\
             请重新启动 ssh-agent。"
                .to_string(),
        ),
        Err(e) => Err(format!("连接 SSH Agent 失败：{e}")),
    }
}

/// RSA 的签名哈希：优先听服务器 `server-sig-algs` 的偏好，拿不到就按 rsa-sha2-256 试。
/// 非 RSA 固定为 None（对它们这个参数没有意义）。
async fn rsa_hash_alg<H: russh::client::Handler>(
    session: &Handle<H>,
    algorithm: Algorithm,
) -> Option<HashAlg> {
    if !algorithm.is_rsa() {
        return None;
    }
    match session.best_supported_rsa_hash().await {
        Ok(Some(alg)) => alg,
        _ => Some(HashAlg::Sha256),
    }
}

/// 读私钥。**只读路径**：不复制、不落盘、不缓存私钥材料。
fn load_private_key(path: &str, passphrase: Option<&str>) -> Result<ssh_key::PrivateKey, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("请先选择私钥文件".to_string());
    }
    russh::keys::load_secret_key(trimmed, passphrase)
        .map_err(|e| describe_key_error(trimmed, &e, passphrase))
}

/// 把私钥加载的底层错误翻译成「下一步该做什么」
fn describe_key_error(path: &str, error: &KeysError, passphrase: Option<&str>) -> String {
    let shown = display_path(path);
    match error {
        KeysError::IO(io) if io.kind() == std::io::ErrorKind::NotFound => format!(
            "私钥文件不存在：{shown}。请检查路径，或用「选择文件」重新挑一把私钥。"
        ),
        KeysError::IO(io) if io.kind() == std::io::ErrorKind::PermissionDenied => format!(
            "没有权限读取私钥文件 {shown}。请检查文件权限（OpenSSH 要求私钥只对本人可读）。"
        ),
        KeysError::IO(io) => format!("读取私钥文件 {shown} 失败：{io}"),
        KeysError::KeyIsEncrypted => format!(
            "私钥 {shown} 带口令保护，需要先填「私钥口令」再连接。"
        ),
        // 口令不对时底层只会给一个笼统的加解密错误，这里结合「有没有填口令」给出可操作提示
        KeysError::SshKey(ssh_key::Error::Crypto)
        | KeysError::SshKey(ssh_key::Error::Encrypted)
        | KeysError::Unpad(_)
        | KeysError::Pad(_)
            if passphrase.is_some() =>
        {
            format!("私钥 {shown} 的口令不正确。请重新输入私钥口令。")
        }
        KeysError::UnsupportedKeyType {
            key_type_string, ..
        } => format!(
            "不支持这种私钥：{key_type_string}。TermX 支持 Ed25519、RSA、ECDSA。"
        ),
        KeysError::SshKey(ssh_key::Error::AlgorithmUnknown)
        | KeysError::SshKey(ssh_key::Error::AlgorithmUnsupported { .. }) => format!(
            "私钥 {shown} 用到了 TermX 不支持的算法。请换一把 Ed25519 / RSA / ECDSA 私钥。"
        ),
        KeysError::CouldNotReadKey | KeysError::KeyIsCorrupt => format!(
            "无法解析私钥 {shown}：文件格式不认识或内容已损坏。\
             TermX 支持 OpenSSH、PKCS#8、PEM 格式（不支持 PuTTY 的 .ppk）。"
        ),
        other => format!("读取私钥 {shown} 失败：{other}"),
    }
}

/// 服务器愿意接受哪些认证方式，用于失败文案
fn methods_text(methods: &russh::MethodSet) -> String {
    let list: Vec<String> = methods.iter().map(String::from).collect();
    if list.is_empty() {
        "（服务器没有说明）".to_string()
    } else {
        list.join("、")
    }
}

/// home 目录下的路径缩写成 `~/.ssh/id_ed25519`，报错时更好认
fn display_path(path: &str) -> String {
    let path = path.trim();
    if let Some(home) = std::env::home_dir() {
        let home = home.to_string_lossy().replace('\\', "/");
        let normalized = path.replace('\\', "/");
        let prefix = format!("{home}/");
        if let Some(rest) = normalized.strip_prefix(&prefix) {
            return format!("~/{rest}");
        }
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::PublicKeyOrCertificate;
    use russh::keys::PublicKey;
    use russh::Signer;
    use std::path::{Path, PathBuf};

    /// 四（五）种凭据的 JSON 形态必须与前端一致，尤其是 `passphrase: null`
    #[test]
    fn credential_json_covers_all_methods() {
        let password: Credential =
            serde_json::from_str(r#"{"method":"password","password":"hunter2"}"#).unwrap();
        match password {
            Credential::Password { password } => assert_eq!(password, "hunter2"),
            other => panic!("应解析为密码凭据，实际 {other:?}"),
        }

        let keyed: Credential = serde_json::from_str(
            r#"{"method":"private_key","path":"C:/Users/x/.ssh/id_ed25519","passphrase":"p@ss"}"#,
        )
        .unwrap();
        match keyed {
            Credential::PrivateKey { path, passphrase } => {
                assert_eq!(path, "C:/Users/x/.ssh/id_ed25519");
                assert_eq!(passphrase.as_deref(), Some("p@ss"));
            }
            other => panic!("应解析为私钥凭据，实际 {other:?}"),
        }

        // 前端在「私钥没有口令」时传的是 null
        let null_pass: Credential = serde_json::from_str(
            r#"{"method":"private_key","path":"/home/x/.ssh/id_rsa","passphrase":null}"#,
        )
        .unwrap();
        match null_pass {
            Credential::PrivateKey { passphrase, .. } => {
                assert!(passphrase.is_none(), "null 应解析成 None");
            }
            other => panic!("应解析为私钥凭据，实际 {other:?}"),
        }

        // 字段整个缺失也要能解析（等价于没有口令）
        let missing: Credential =
            serde_json::from_str(r#"{"method":"private_key","path":"/home/x/.ssh/id_rsa"}"#).unwrap();
        assert!(matches!(
            missing,
            Credential::PrivateKey {
                passphrase: None,
                ..
            }
        ));

        assert!(matches!(
            serde_json::from_str::<Credential>(r#"{"method":"agent"}"#).unwrap(),
            Credential::Agent
        ));
        assert!(matches!(
            serde_json::from_str::<Credential>(r#"{"method":"keyboard_interactive"}"#).unwrap(),
            Credential::KeyboardInteractive
        ));

        // 不认识的 method 必须报错，不能悄悄退化成某一种方式
        assert!(
            serde_json::from_str::<Credential>(r#"{"method":"gssapi"}"#).is_err(),
            "未知 method 不应被接受"
        );
    }

    /// `ssh://auth-prompt/{key}` 的载荷形状（含 echo）必须钉住，前端按它渲染输入框
    #[test]
    fn auth_prompt_payload_keeps_echo_flag() {
        let payload = AuthPromptPayload {
            name: "MFA".to_string(),
            instructions: "请输入验证码".to_string(),
            prompts: vec![
                AuthPromptItem {
                    prompt: "Password: ".to_string(),
                    echo: false,
                },
                AuthPromptItem {
                    prompt: "Verification code: ".to_string(),
                    echo: true,
                },
            ],
        };

        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["name"], serde_json::json!("MFA"));
        assert_eq!(json["instructions"], serde_json::json!("请输入验证码"));
        assert_eq!(json["prompts"][0]["prompt"], serde_json::json!("Password: "));
        assert_eq!(json["prompts"][0]["echo"], serde_json::json!(false));
        assert_eq!(json["prompts"][1]["echo"], serde_json::json!(true));
    }

    /// 键盘交互的应答通道：没有请求时应答要报错；注册后应答能送达；取消能唤醒等待方
    #[tokio::test]
    async fn auth_prompt_registry_delivers_and_cancels() {
        let registry = AuthPromptRegistry::default();

        assert!(
            registry
                .resolve("k1", vec!["123456".to_string()])
                .is_err(),
            "没有等待中的请求时应报错"
        );

        let receiver = registry.register("k1").unwrap();
        registry
            .resolve("k1", vec!["123456".to_string()])
            .unwrap();
        assert_eq!(
            receiver.await.unwrap().unwrap(),
            vec!["123456".to_string()]
        );

        // 取消：等待方应拿到原因，而不是一直挂着
        let receiver = registry.register("k2").unwrap();
        registry.cancel("k2", "用户取消了连接");
        assert_eq!(
            receiver.await.unwrap().unwrap_err(),
            "用户取消了连接".to_string()
        );
    }

    fn test_dir(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("termx-auth-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 用 ssh-keygen 现场生成一把临时私钥；机器上没有 ssh-keygen 时返回 None（跳过而不是失败）
    fn ssh_keygen(dir: &Path, name: &str, passphrase: Option<&str>) -> Option<PathBuf> {
        let path = dir.join(name);
        let status = std::process::Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", passphrase.unwrap_or(""), "-C", "termx-test", "-f"])
            .arg(&path)
            .status()
            .ok()?;
        status.success().then_some(path)
    }

    /// 明文私钥要能加载；带口令的私钥「错口令必须失败、对口令必须成功」——
    /// 这条正是「私钥加口令」路径的核心，防止口令被无声忽略。
    #[test]
    fn private_key_loading_covers_plain_and_passphrase_protected() {
        let dir = test_dir("keys");

        let Some(plain) = ssh_keygen(&dir, "plain", None) else {
            eprintln!("跳过：本机没有可用的 ssh-keygen");
            return;
        };
        let key = load_private_key(plain.to_str().unwrap(), None).expect("明文私钥应能加载");
        assert_eq!(key.algorithm().to_string(), "ssh-ed25519");

        let Some(protected) = ssh_keygen(&dir, "protected", Some("termx-test-pass")) else {
            eprintln!("跳过：本机没有可用的 ssh-keygen");
            return;
        };
        let path = protected.to_str().unwrap().to_string();

        // 正确口令必须成功
        let key =
            load_private_key(&path, Some("termx-test-pass")).expect("正确口令应能解开加密私钥");
        assert_eq!(key.algorithm().to_string(), "ssh-ed25519");

        // 错误口令必须失败，且文案要明确指出是「口令不正确」（而不是别的原因）
        let message = load_private_key(&path, Some("definitely-wrong-passphrase"))
            .expect_err("错误口令不应解开加密私钥");
        assert!(
            message.contains("口令不正确"),
            "错误口令的提示应说明口令不正确，实际：{message}"
        );

        // 完全不给口令也必须失败，并提示需要先填口令
        let message = load_private_key(&path, None).expect_err("没给口令不应解开加密私钥");
        assert!(
            message.contains("需要先填"),
            "缺少口令的提示应说明需要先填口令，实际：{message}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 文件不存在要给出可操作的提示
    #[test]
    fn missing_private_key_file_is_actionable() {
        let message = load_private_key("C:/definitely/not/here/id_ed25519", None)
            .expect_err("不存在的私钥文件应报错");
        assert!(
            message.contains("不存在"),
            "提示应说明文件不存在，实际：{message}"
        );

        // 空路径（用户没选文件就点了连接）
        assert!(load_private_key("   ", None).is_err());
    }

    /// `~` 缩写：报错文案里能直接对上用户自己的路径
    #[test]
    fn display_path_shortens_home_directory() {
        assert_eq!(display_path("/tmp/id_ed25519"), "/tmp/id_ed25519");
        if let Some(home) = std::env::home_dir() {
            let inside = home.join(".ssh").join("id_ed25519");
            let shown = display_path(&inside.to_string_lossy());
            if shown.starts_with("~/") {
                assert!(shown.ends_with(".ssh/id_ed25519"), "缩写结果异常：{shown}");
            }
        }
    }

    /// Agent 认证依赖「`dynamic()` 之后的具体类型实现 russh 的 `Signer`」。
    /// 这是编译期验证：不满足约束这一行就编译不过。
    #[test]
    fn boxed_agent_satisfies_the_signer_contract() {
        fn assert_signer<S: Signer>() {}
        fn assert_error_bound<S: Signer>()
        where
            S::Error: From<russh::SendError>,
        {
        }
        assert_signer::<BoxedAgent>();
        assert_error_bound::<BoxedAgent>();
    }

    /// 构造一条假的 agent 流，真的走一遍 `AgentClient::connect(..).dynamic()` →
    /// `Signer::auth_sign`：确认「统一类型 + russh 内置 Signer 实现」这条调用链成立。
    /// 对端被丢弃，签名必然失败 —— 我们要的就是它走通类型、不阻塞、并如实报错。
    #[test]
    fn fake_agent_stream_can_drive_the_signer_path() {
        let (server, client) = tokio::io::duplex(64);
        drop(server);
        let mut agent: BoxedAgent = AgentClient::connect(client).dynamic();

        let key: PublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMA6n+DQWVPOxphqrRcQRfq6san3Tlu/Sevut+ELlKjJ"
            .parse()
            .expect("夹具公钥应可解析");
        let identity = AgentIdentity::PublicKey {
            key,
            comment: "termx-test".to_string(),
        };

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let error = runtime.block_on(async {
            match agent.auth_sign(&identity, None, vec![0u8; 32]).await {
                Ok(_) => panic!("对端已经关闭，不该返回签名"),
                Err(error) => error,
            }
        });
        eprintln!("假 agent 的签名调用按预期失败：{error}");
    }

    /// 真实主机集成测试：门控在 TERMX_TEST_SSH_* 环境变量上，**凭据一律不写进仓库**。
    /// 需要的变量：TERMX_TEST_SSH_HOST / TERMX_TEST_SSH_USER / TERMX_TEST_SSH_KEY
    /// （可选 TERMX_TEST_SSH_PORT、TERMX_TEST_SSH_KEY_PASSPHRASE）。
    struct TestHandler;

    impl russh::client::Handler for TestHandler {
        type Error = russh::Error;

        async fn check_server_key(
            &mut self,
            _server_public_key: &russh::keys::PublicKeyOrCertificate,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn real_host_private_key_auth() {
        let (Ok(host), Ok(user), Ok(key_path)) = (
            std::env::var("TERMX_TEST_SSH_HOST"),
            std::env::var("TERMX_TEST_SSH_USER"),
            std::env::var("TERMX_TEST_SSH_KEY"),
        ) else {
            eprintln!("跳过：未提供 TERMX_TEST_SSH_HOST / _USER / _KEY 环境变量");
            return;
        };
        let port = std::env::var("TERMX_TEST_SSH_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(22);
        let passphrase = std::env::var("TERMX_TEST_SSH_KEY_PASSPHRASE").ok();

        let mut session = russh::client::connect(
            Arc::new(russh::client::Config::default()),
            (host.as_str(), port),
            TestHandler,
        )
        .await
        .expect("TCP/握手阶段失败");

        let detail = private_key_auth(&mut session, &user, &key_path, passphrase.as_deref())
            .await
            .unwrap_or_else(|e| panic!("私钥认证未通过（{user}@{host}）：{e}"));
        eprintln!("{detail}");
    }

    /// 键盘交互的核心往返：登记等待 → 投递提问 → 等到回答。
    ///
    /// 这里把 `app` 传 None（不发事件），直接在 registry 侧作答 ——
    /// 模拟的正是「界面收到事件、用户填完点提交」那一端的行为。
    #[tokio::test]
    async fn ask_user_round_trip_delivers_prompt_and_returns_answers() {
        let registry = Arc::new(AuthPromptRegistry::default());
        let key = "ki-round-trip";
        let items = vec![
            Prompt {
                prompt: "Password: ".to_string(),
                echo: false,
            },
            Prompt {
                prompt: "Verification code: ".to_string(),
                echo: true,
            },
        ];

        let answerer = {
            let registry = registry.clone();
            tokio::spawn(async move {
                // 登记发生在 ask_user 内部、先于等待；这里轮询到登记完成再作答
                for _ in 0..200 {
                    if registry
                        .resolve(key, vec!["hunter2".to_string(), "123456".to_string()])
                        .is_ok()
                    {
                        return true;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                false
            })
        };

        let answers = ask_user(None, key, &registry, "服务器", "请输入", &items)
            .await
            .expect("应当拿到界面提交的回答");

        assert!(answerer.await.unwrap(), "应答方没能对上注册的通道");
        assert_eq!(answers, vec!["hunter2".to_string(), "123456".to_string()]);
    }

    /// 用户取消时要立刻被唤醒，并把取消原因如实带出来，而不是干等到超时
    #[tokio::test]
    async fn ask_user_surfaces_cancellation_with_reason() {
        let registry = Arc::new(AuthPromptRegistry::default());
        let key = "ki-cancel";
        let items = vec![Prompt {
            prompt: "Password: ".to_string(),
            echo: false,
        }];

        let canceller = {
            let registry = registry.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                registry.cancel(key, "用户取消了这次认证");
            })
        };

        let error = ask_user(None, key, &registry, "服务器", "请输入", &items)
            .await
            .expect_err("被取消时应当返回错误");

        canceller.await.unwrap();
        assert!(
            error.contains("用户取消了这次认证"),
            "错误里要带上取消原因，实际是：{error}"
        );
    }

    /// 登记被撤掉之后再投递回答，必须报错而不是静默丢弃
    #[tokio::test]
    async fn resolving_without_waiting_request_is_rejected() {
        let registry = AuthPromptRegistry::default();
        let error = registry
            .resolve("nobody-waiting", vec!["x".to_string()])
            .expect_err("没有等待中的请求时不该接受回答");
        assert!(
            error.contains("没有等待输入"),
            "错误文案要说清是没有等待中的请求，实际是：{error}"
        );
    }

    // ---------------------------------------------------------------------
    // 下面这条测试自带一台「要求键盘交互」的 SSH 服务器，把整条循环跑完：
    // 服务器提问 → 循环登记并投递提问 → 代界面作答 → 循环提交回答 → 服务器放行。
    //
    // 为什么自带：手上两台真实服务器都没启用键盘交互（sshd 报的可用方式里
    // 不含 keyboard-interactive），而这条路径恰恰是最需要真跑一遍的。
    // ---------------------------------------------------------------------

    const KI_ANSWER: &str = "s3cret";

    #[derive(Clone, Default)]
    struct KiHandler {
        received: Arc<tokio::sync::Mutex<Vec<String>>>,
    }

    impl russh::server::Handler for KiHandler {
        type Error = russh::Error;

        async fn auth_keyboard_interactive<'a>(
            &'a mut self,
            _user: &str,
            _submethods: &str,
            response: Option<russh::server::Response<'a>>,
        ) -> Result<russh::server::Auth, Self::Error> {
            match response {
                // 第一轮：把两个提问发下去（一个密码类、一个回显类）
                None => Ok(russh::server::Auth::Partial {
                    name: "TermX 测试服务器".into(),
                    instructions: "请输入约定口令".into(),
                    prompts: vec![("Password: ".into(), false), ("Code: ".into(), true)].into(),
                }),
                // 第二轮：校验客户端提交的回答
                Some(answers) => {
                    let got: Vec<String> = answers
                        .map(|b| String::from_utf8_lossy(&b).to_string())
                        .collect();
                    let ok = got == vec![KI_ANSWER.to_string(), "123456".to_string()];
                    *self.received.lock().await = got;
                    Ok(if ok {
                        russh::server::Auth::Accept
                    } else {
                        russh::server::Auth::reject()
                    })
                }
            }
        }
    }

    struct AcceptAnyKey;

    impl russh::client::Handler for AcceptAnyKey {
        type Error = russh::Error;

        async fn check_server_key(
            &mut self,
            _key: &PublicKeyOrCertificate,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn keyboard_interactive_full_loop_against_a_test_server() {
        // 主机密钥现场生成，与本文件其它测试一致，不引入新的加密依赖
        let mut dir = std::env::temp_dir();
        dir.push(format!("termx-ki-server-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let host_key_path = dir.join("host_ed25519");
        let _ = std::fs::remove_file(&host_key_path);

        let status = std::process::Command::new("ssh-keygen")
            .args(["-t", "ed25519", "-N", "", "-q", "-f"])
            .arg(&host_key_path)
            .status()
            .expect("需要本机有 ssh-keygen 才能生成测试主机密钥");
        assert!(status.success(), "ssh-keygen 生成主机密钥失败");

        let host_key =
            russh::keys::load_secret_key(&host_key_path, None).expect("加载测试主机密钥失败");
        let config = Arc::new(russh::server::Config {
            keys: vec![host_key],
            inactivity_timeout: Some(Duration::from_secs(30)),
            ..Default::default()
        });

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let received: Arc<tokio::sync::Mutex<Vec<String>>> =
            Arc::new(tokio::sync::Mutex::new(Vec::new()));

        let server_task = {
            let handler = KiHandler {
                received: received.clone(),
            };
            tokio::spawn(async move {
                if let Ok((stream, _)) = listener.accept().await {
                    let _ = russh::server::run_stream(config, stream, handler).await;
                }
            })
        };

        let mut session = russh::client::connect(
            Arc::new(russh::client::Config::default()),
            addr,
            AcceptAnyKey,
        )
        .await
        .expect("连接本地测试服务器失败");

        let registry = Arc::new(AuthPromptRegistry::default());
        let key = "ki-full-loop";

        // 代界面作答：轮询到登记完成就把两个答案交上去
        let answerer = {
            let registry = registry.clone();
            tokio::spawn(async move {
                for _ in 0..400 {
                    if registry
                        .resolve(key, vec![KI_ANSWER.to_string(), "123456".to_string()])
                        .is_ok()
                    {
                        return true;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                false
            })
        };

        // app 传 None：不发事件，由上面的应答方代替界面
        keyboard_interactive_auth(None, key, &mut session, "tester", &registry)
            .await
            .expect("键盘交互应当认证通过");

        assert!(answerer.await.unwrap(), "应答方没能对上注册的通道");
        assert_eq!(
            received.lock().await.clone(),            vec![KI_ANSWER.to_string(), "123456".to_string()],
            "服务器收到的回答应与提交的一致，且顺序对应两个提问"
        );

        server_task.abort();
    }
}
