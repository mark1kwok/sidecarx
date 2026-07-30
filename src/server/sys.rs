use axum::{response::IntoResponse, Json};
use serde::Serialize;
use sysinfo::{Disks, System};
use std::sync::{Mutex, OnceLock};

static SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();

fn get_system() -> &'static Mutex<System> {
    SYSTEM.get_or_init(|| {
        let mut sys = System::new_all();
        // Initial refresh so CPU delta calculation has a baseline
        sys.refresh_all();
        Mutex::new(sys)
    })
}

#[derive(Serialize)]
pub struct SysStats {
    pub ram_total: u64,
    pub ram_used: u64,
    pub ram_available: u64,
    pub disk_total: u64,
    pub disk_used: u64,
    pub disk_available: u64,
    pub cpu_usage: f32,
}

fn get_cgroup_memory() -> Option<(u64, u64, u64)> {
    let limit_str = std::fs::read_to_string("/sys/fs/cgroup/memory.max").ok()?;
    let current_str = std::fs::read_to_string("/sys/fs/cgroup/memory.current").ok()?;

    let limit_trimmed = limit_str.trim();
    let current_trimmed = current_str.trim();

    if limit_trimmed == "max" {
        return None;
    }

    let limit_bytes = limit_trimmed.parse::<u64>().ok()?;
    let current_bytes = current_trimmed.parse::<u64>().ok()?;

    let available_bytes = limit_bytes.saturating_sub(current_bytes);

    Some((limit_bytes, current_bytes, available_bytes))
}

pub async fn get_sys_stats() -> impl IntoResponse {
    let (ram_total, ram_used, ram_available, cpu_usage) = {
        let mut sys = get_system().lock().unwrap();
        sys.refresh_all();

        let cpu = sys.global_cpu_info().cpu_usage();

        if let Some((cg_total, cg_used, cg_avail)) = get_cgroup_memory() {
            (cg_total, cg_used, cg_avail, cpu)
        } else {
            (
                sys.total_memory(),
                sys.used_memory(),
                sys.available_memory(),
                cpu,
            )
        }
    };

    // Disks
    let disks = Disks::new_with_refreshed_list();
    let mut disk_total: u64 = 0;
    let mut disk_available: u64 = 0;
    for disk in &disks {
        disk_total += disk.total_space();
        disk_available += disk.available_space();
    }

    let disk_used = disk_total.saturating_sub(disk_available);

    let stats = SysStats {
        ram_total,
        ram_used,
        ram_available,
        disk_total,
        disk_used,
        disk_available,
        cpu_usage,
    };

    Json(stats)
}
