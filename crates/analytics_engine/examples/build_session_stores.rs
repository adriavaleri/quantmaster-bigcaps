use std::{error::Error, io, path::PathBuf};

use analytics_engine::{SessionFilterStoreBuilder, STORE_DIR_NAME};

fn main() -> Result<(), Box<dyn Error>> {
    let roots: Vec<_> = std::env::args().skip(1).collect();
    if roots.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Provide at least one dataset root",
        )
        .into());
    }

    let mut expected_coverage = None;
    for input in roots {
        let root = PathBuf::from(input).canonicalize()?;
        let report = SessionFilterStoreBuilder::build(&root, None)?;
        if SessionFilterStoreBuilder::current_report(
            &root,
            &root.join("runtime").join(STORE_DIR_NAME),
        )?
        .is_none()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Store validation failed: {}", root.display()),
            )
            .into());
        }
        let coverage = (
            report.years.clone(),
            report.rows,
            report.profile_years.clone(),
            report.profile_rows,
        );
        if let Some(expected) = &expected_coverage {
            if expected != &coverage {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "Store coverage differs between data roots: expected {expected:?}, got {coverage:?} at {}",
                        root.display()
                    ),
                )
                .into());
            }
        } else {
            expected_coverage = Some(coverage);
        }
        println!(
            "{}\n{}",
            root.display(),
            serde_json::to_string_pretty(&report)?
        );
    }

    Ok(())
}
