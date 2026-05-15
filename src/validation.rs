use anyhow::anyhow;
use connectrpc::ConnectError;

use crate::config::{MAX_COLS, MAX_ROWS};

pub fn validate_selector(selector: &str) -> Result<(), ConnectError> {
    let selector = selector.trim();
    let Some((name, owner_deploy_id)) = selector.split_once('@') else {
        return Err(ConnectError::invalid_argument(
            "selector must have shape <name>@<owner_deploy_id>",
        ));
    };
    if selector.matches('@').count() != 1
        || name.trim().is_empty()
        || owner_deploy_id.trim().is_empty()
        || selector.contains('/')
        || selector.contains('\\')
        || selector.chars().any(char::is_control)
    {
        return Err(ConnectError::invalid_argument(
            "selector must have shape <name>@<owner_deploy_id>",
        ));
    }
    Ok(())
}

pub fn required_field<'a>(value: Option<&'a str>, name: &str) -> Result<&'a str, ConnectError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ConnectError::invalid_argument(format!("{name} is required")))
}

pub fn normalize_dimension(
    value: Option<i32>,
    default_value: u16,
    max_value: u16,
    name: &str,
) -> Result<u16, ConnectError> {
    let value = value.unwrap_or(i32::from(default_value));
    if value <= 0 || value > i32::from(max_value) {
        return Err(ConnectError::invalid_argument(format!(
            "{name} must be between 1 and {max_value}"
        )));
    }
    u16::try_from(value)
        .map_err(|_| ConnectError::invalid_argument(format!("{name} is out of range")))
}

pub fn validate_size(cols: u16, rows: u16) -> anyhow::Result<()> {
    if cols == 0 || cols > MAX_COLS || rows == 0 || rows > MAX_ROWS {
        return Err(anyhow!(
            "terminal size must be between 1x1 and {MAX_COLS}x{MAX_ROWS}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_selector;

    #[test]
    fn validates_selector_shape() {
        assert!(validate_selector("demo@owner").is_ok());
        assert!(validate_selector("").is_err());
        assert!(validate_selector("demo").is_err());
        assert!(validate_selector("@owner").is_err());
        assert!(validate_selector("demo@").is_err());
        assert!(validate_selector("demo@owner@extra").is_err());
        assert!(validate_selector("demo/../x@owner").is_err());
    }
}
