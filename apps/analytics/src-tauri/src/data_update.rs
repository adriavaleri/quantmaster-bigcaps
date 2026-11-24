use serde::Deserialize;
use std::{
    io::ErrorKind,
    path::PathBuf,
    process::{Command, Stdio},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataUpdate {
    data_root: String,
    start: Option<String>,
    end: Option<String>,
    api_key: String,
    access_key: String,
}

#[tauri::command]
pub async fn update_dataset(request: DataUpdate) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_pipeline(request))
        .await
        .map_err(|_| "The data update task stopped unexpectedly.".to_owned())?
}

fn run_pipeline(request: DataUpdate) -> Result<String, String> {
    let data = PathBuf::from(request.data_root.trim());
    if !data.is_absolute() {
        return Err("Enter an absolute dataset path.".into());
    }
    let (Some(parent), Some(name)) = (data.parent(), data.file_name()) else {
        return Err("Choose a dataset folder inside a drive or share.".into());
    };
    let Some(project) = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
    else {
        return Err("The BigCaps project directory could not be resolved.".into());
    };
    if !project.join("tools/data_pipeline.py").is_file() {
        return Err("The data pipeline is missing. Run BigCaps from its project checkout.".into());
    }

    let mut local_name = project.file_name().unwrap_or_default().to_os_string();
    local_name.push(".local");
    let local_state = project.with_file_name(local_name);
    let work = if data == project.join("data") {
        local_state.join("data_pipeline_work")
    } else {
        let mut work_name = name.to_os_string();
        work_name.push(".bigcaps-work");
        parent.join(work_name)
    };
    let mut args = vec![
        "-m".into(),
        "tools.data_pipeline".into(),
        "update".into(),
        "--data".into(),
        data.into_os_string(),
        "--work".into(),
        work.clone().into_os_string(),
    ];
    match (request.start, request.end) {
        (None, None) => {}
        (Some(start), Some(end)) if iso_date(&start) && iso_date(&end) && start <= end => {
            args.extend(["--start".into(), start.into(), "--end".into(), end.into()]);
        }
        _ => return Err("Enter a valid start and end date.".into()),
    }
    let archive = local_state.join("market_cap_work/full/snapshots.sqlite");
    if archive.is_file() && !work.join("market_cap/snapshots.sqlite").exists() {
        args.extend(["--snapshot-archive".into(), archive.into_os_string()]);
    }

    let flat_files_secret = std::env::var("MASSIVE_S3_SECRET_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            let config = std::fs::read_to_string(local_state.join("keys.env")).ok()?;
            config.trim_start_matches('\u{feff}').lines().find_map(|line| {
                let (name, value) = line.split_once('=')?;
                if name.trim() != "MASSIVE_S3_SECRET_KEY" {
                    return None;
                }
                let value = value.trim().trim_matches(['"', '\'']);
                (!value.is_empty()).then(|| value.to_owned())
            })
        })
        .ok_or_else(|| {
            "Missing Massive Flat Files secret key. Set MASSIVE_S3_SECRET_KEY in the environment or in keys.env in the sibling .local directory.".to_owned()
        })?;
    let updates = [
        ("MASSIVE_API_KEY", request.api_key.trim()),
        ("MASSIVE_S3_ACCESS_KEY", request.access_key.trim()),
        ("MASSIVE_S3_SECRET_KEY", flat_files_secret.as_str()),
    ];
    let mut secrets = Vec::new();
    for (key, value) in updates {
        if !value.is_empty() {
            secrets.push(value.to_owned());
        } else if let Ok(inherited) = std::env::var(key) {
            if !inherited.is_empty() {
                secrets.push(inherited);
            }
        }
    }

    for interpreter in ["python", "py"] {
        let mut command = Command::new(interpreter);
        command
            .current_dir(project)
            .stdin(Stdio::null())
            .args(&args)
            .env("PYTHONIOENCODING", "utf-8");
        for (key, value) in updates {
            if !value.is_empty() {
                command.env(key, value);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let output = match command.output() {
            Ok(output) => output,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Could not start the data pipeline. {error}")),
        };
        let bytes = if output.status.success() || output.stderr.is_empty() {
            &output.stdout
        } else {
            &output.stderr
        };
        let mut detail = String::from_utf8_lossy(bytes).into_owned();
        for secret in &secrets {
            detail = detail.replace(secret, "[redacted]");
        }
        let lines: Vec<_> = detail
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect();
        let summary = lines[lines.len().saturating_sub(5)..].join("\n");
        return if output.status.success() {
            Ok(summary)
        } else {
            Err(format!("The data update failed.\n{summary}"))
        };
    }
    Err("Install Python and the dependencies in tools/requirements-data.txt.".into())
}

fn iso_date(value: &str) -> bool {
    value.len() == 10
        && value.bytes().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
}
