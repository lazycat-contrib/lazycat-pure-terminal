use std::time::Duration;

use connectrpc::ConnectError;
use serde::Deserialize;
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
