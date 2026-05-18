use std::time::Duration;

use connectrpc::ConnectError;
use serde::Deserialize;
use serde::Serialize;
use tokio::time::timeout;

use crate::config::LIGHTOSCTL;
use crate::proto::lazycat::webshell::v1::Instance;

#[derive(Debug, Deserialize)]
struct LightOsInstance {
    #[serde(default)]
    name: String,
    #[serde(default)]
    owner_deploy_id: String,
    #[serde(default)]
    status: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AdminInfo {
    #[serde(default)]
    pub deploy_id: String,
    #[serde(default)]
    pub domain: String,
    #[serde(default)]
    pub base_url: String,
}

pub async fn list_instances() -> Result<Vec<Instance>, ConnectError> {
    let output = run_lightosctl(["ps"]).await?;
    let mut items: Vec<LightOsInstance> = serde_json::from_slice(&output)
        .map_err(|err| ConnectError::internal(format!("invalid lightosctl ps JSON: {err}")))?;
    items.sort_by_key(|item| item.status != "running");
    Ok(items
        .into_iter()
        .filter_map(|item| {
            if item.name.trim().is_empty() || item.owner_deploy_id.trim().is_empty() {
                return None;
            }
            Some(Instance {
                selector: Some(format!("{}@{}", item.name, item.owner_deploy_id)),
                name: Some(item.name),
                owner_deploy_id: Some(item.owner_deploy_id),
                status: Some(item.status),
                ..Default::default()
            })
        })
        .collect())
}

pub async fn admin_info() -> Result<AdminInfo, ConnectError> {
    let output = run_lightosctl(["system", "admin-info", "--json"]).await?;
    parse_admin_info(&output)
}

fn parse_admin_info(output: &[u8]) -> Result<AdminInfo, ConnectError> {
    let mut info: AdminInfo = serde_json::from_slice(output)
        .map_err(|err| ConnectError::internal(format!("invalid admin-info JSON: {err}")))?;
    trim_string(&mut info.deploy_id);
    trim_string(&mut info.domain);
    trim_string(&mut info.base_url);
    if info.base_url.is_empty() {
        return Err(ConnectError::failed_precondition(
            "lightos-admin base_url is unavailable",
        ));
    }
    let uri = info.base_url.parse::<http::Uri>().map_err(|err| {
        ConnectError::failed_precondition(format!("invalid lightos-admin base_url: {err}"))
    })?;
    if uri.scheme_str().is_none() || uri.authority().is_none() {
        return Err(ConnectError::failed_precondition(
            "lightos-admin base_url must include scheme and host",
        ));
    }
    Ok(info)
}

fn trim_string(value: &mut String) {
    let trimmed = value.trim();
    if trimmed.len() == value.len() {
        return;
    }
    let owned = trimmed.to_owned();
    value.clear();
    value.push_str(&owned);
}

async fn run_lightosctl<const N: usize>(args: [&str; N]) -> Result<Vec<u8>, ConnectError> {
    let mut command = tokio::process::Command::new(LIGHTOSCTL);
    command.args(args);
    let output = timeout(Duration::from_secs(8), command.output())
        .await
        .map_err(|_| ConnectError::deadline_exceeded("lightosctl timed out"))?
        .map_err(|err| ConnectError::unavailable(format!("failed to run lightosctl: {err}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(ConnectError::failed_precondition(format!(
            "lightosctl failed: {detail}"
        )));
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::parse_admin_info;

    #[test]
    fn parses_admin_info_with_base_url() {
        let info = parse_admin_info(br#"{"deploy_id":" deploy-a ","domain":" admin.local ","base_url":" https://admin.local/root/ "}"#)
            .expect("admin info parses");

        assert_eq!(info.deploy_id, "deploy-a");
        assert_eq!(info.domain, "admin.local");
        assert_eq!(info.base_url, "https://admin.local/root/");
    }

    #[test]
    fn rejects_admin_info_without_absolute_base_url() {
        let err = parse_admin_info(br#"{"base_url":"/"}"#).expect_err("base_url must be absolute");

        assert!(err.message.unwrap_or_default().contains("scheme and host"));
    }
}
