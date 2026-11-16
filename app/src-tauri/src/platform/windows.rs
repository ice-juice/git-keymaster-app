//! Windows private files use a protected DACL containing only the process user SID.

use super::PlatformOps;
use crate::error::{AppError, Result};
use crate::sys;
use std::path::{Path, PathBuf};

pub struct Windows;

impl PlatformOps for Windows {
    fn secure_key_file(&self, path: &Path) -> Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
        use windows_sys::Win32::Security::Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        };
        use windows_sys::Win32::Security::{
            GetTokenInformation, SetFileSecurityW, TokenUser, DACL_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        let fail = || {
            AppError::Io(format!(
                "设置仅本人可读写的文件权限失败：{}",
                std::io::Error::last_os_error()
            ))
        };
        let filename: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if filename[..filename.len() - 1].contains(&0) {
            return Err(AppError::Invalid("文件路径包含NUL".into()));
        }
        // All pointers below live through their calls; token storage is usize-aligned.
        unsafe {
            let mut token = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(fail());
            }
            let mut size = 0;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
            if size == 0 {
                let error = fail();
                CloseHandle(token);
                return Err(error);
            }
            let mut storage = vec![
                0usize;
                (size as usize + std::mem::size_of::<usize>() - 1)
                    / std::mem::size_of::<usize>()
            ];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                storage.as_mut_ptr().cast(),
                size,
                &mut size,
            );
            let error = if ok == 0 { Some(fail()) } else { None };
            CloseHandle(token);
            if let Some(error) = error {
                return Err(error);
            }
            let user = &*storage.as_ptr().cast::<TOKEN_USER>();
            let mut sid_text = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut sid_text) == 0 {
                return Err(fail());
            }
            let mut len = 0;
            while *sid_text.add(len) != 0 {
                len += 1;
            }
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(sid_text, len));
            LocalFree(sid_text.cast());
            let sddl: Vec<u16> = format!("D:P(A;;FA;;;{sid})")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut descriptor = std::ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(fail());
            }
            let ok = SetFileSecurityW(
                filename.as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                descriptor,
            );
            let result = if ok == 0 { Err(fail()) } else { Ok(()) };
            LocalFree(descriptor);
            result
        }
    }

    fn ssh_dir(&self) -> PathBuf {
        sys::ssh_dir()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::ffi::OsStrExt;

    #[test]
    fn secure_file_replaces_explicit_everyone_ace_with_one_protected_allow() {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW,
            SE_FILE_OBJECT,
        };
        use windows_sys::Win32::Security::{
            GetAce, GetSecurityDescriptorControl, SetFileSecurityW, ACE_HEADER,
            DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
        };
        let dir = std::env::temp_dir().join(format!("gkm-acl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("synthetic-key");
        std::fs::write(&file, b"synthetic test material, not a key").unwrap();
        let filename: Vec<u16> = file.as_os_str().encode_wide().chain(Some(0)).collect();
        let sddl: Vec<u16> = "D:P(A;;FA;;;WD)(A;;FR;;;BU)"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            let mut descriptor = std::ptr::null_mut();
            assert_ne!(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    1,
                    &mut descriptor,
                    std::ptr::null_mut()
                ),
                0
            );
            let installed = SetFileSecurityW(
                filename.as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                descriptor,
            );
            LocalFree(descriptor);
            assert_ne!(installed, 0);
        }
        Windows.secure_key_file(&file).unwrap();
        unsafe {
            let mut dacl = std::ptr::null_mut();
            let mut descriptor = std::ptr::null_mut();
            assert_eq!(
                GetNamedSecurityInfoW(
                    filename.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut dacl,
                    std::ptr::null_mut(),
                    &mut descriptor
                ),
                0
            );
            let mut control = 0;
            let mut revision = 0;
            let got_control = GetSecurityDescriptorControl(descriptor, &mut control, &mut revision);
            let count = if dacl.is_null() { 0 } else { (*dacl).AceCount };
            let mut ace = std::ptr::null_mut();
            let got_ace = if dacl.is_null() {
                0
            } else {
                GetAce(dacl, 0, &mut ace)
            };
            let ace_type = if got_ace == 0 {
                u8::MAX
            } else {
                (*ace.cast::<ACE_HEADER>()).AceType
            };
            LocalFree(descriptor);
            assert_ne!(got_control, 0);
            assert_ne!(control & SE_DACL_PROTECTED, 0);
            assert_eq!(
                count, 1,
                "old explicit Everyone/Users grants must both disappear"
            );
            assert_eq!(ace_type, 0, "the sole ACE must be ACCESS_ALLOWED_ACE_TYPE");
        }
        assert_eq!(
            std::fs::read(&file).unwrap(),
            b"synthetic test material, not a key"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
