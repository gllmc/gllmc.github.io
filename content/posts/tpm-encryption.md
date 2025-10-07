+++
title = "TPM-based disk encryption"
date = 2025-10-07
+++

Nowadays, disk encryption is a must-have feature for devices, especially those susceptible to be carried around, like laptops. On macOS and Windows computers, it is now almost always enabled by default, using secure hardware (Secure Enclave or Trusted Platform Module) to store the encryption keys.

On Linux, disk encryption is also widely used, but it requires the system to be installed on a LUKS-encrypted partition, and the master key is usually derived from a passphrase. For this to be secure, a high-entropy passphrase is required, whose input at each boot can be inconvenient. I therefore wanted to rely on my TPM to unlock my Arch laptop. Thanks notably to the **systemd** development team, there has been some significant progress in this area recently. I learned a few things while setting this up, which motivated me to write this post.

## What is a TPM?

A TPM is a secure hardware module, which is usually integrated into the CPU. It is able to **store** cryptographic keys and **control** the conditions under which they can be used. It is designed to make the physical extraction of keys extremely difficult. Relying on secure hardware to protect data without knowledge of a high-entropy secret is now common, for example with YubiKeys or Google Password Manager, which allows [data recovery using only the device's PIN or pattern](https://security.googleblog.com/2022/10/SecurityofPasskeysintheGooglePasswordManager.html).

There have been different versions of the TPM standard, but all recent (non-Mac) computers are equipped with TPM 2.0, partly because it is a requirement for Windows 11.

The idea behind TPM-based encryption is to let the TPM automatically provide the key material when the system boots up. The TPM controls that the correct system is starting before giving it access to the key, and the security then relies on the fact that the system authenticates the user (using a PIN or biometrics) before opening the session. Naturally, this weakens the security, because it opens the door to several attacks, like potential vulnerabilities in the system authentication mechanism, fault injection on the TPM with dedicated equipment, or [cold boot](https://en.wikipedia.org/wiki/Cold_boot_attack) attacks. Nonetheless, it remains largely sufficient for most people's threat model.

But how can the TPM verify that the legitimate system is booting up? This is where _Platform Configuration Registers_ (PCRs) come into play. These registers are initialized on startup and they contain _hash values_ measuring information about the system state. PCRs 0-7 are intended for the firmware, while PCRs 8-15 are intended for the operating system. The only possible operation is to extend them with data, typically:

$$\mathtt{PCR} := \mathtt{sha256}(\mathtt{PCR} \mathbin\Vert \text{data})$$

In particular, once something has been measured into a PCR, it is supposed to be computationally infeasible to give it an arbitrary value. Keys stored in the TPM can be associated with a set of PCR values. They are only released if the current PCR values match the expected ones. The most important firmware PCRs for our purpose are:

- PCR 0: the UEFI firmware code
- PCR 2: extended executable code (OpROMs, for instance a BIOS Nvidia driver)
- PCR 4: code of the bootloader and the devices boot has been attempted from
- PCR 7: the Secure Boot configuration and the certificates used to validate boot applications

Is is even possible to bind a key not with a single value, but with a public key, which is known as a _PCR signing policy_. The requesting system must then provide a signature of the current PCR value forged with the matching private key. We'll see later how this can be useful.

On a Linux system with systemd installed, you can inspect the current PCR values using the command:

```bash
systemd-analyse pcrs
```

All PCRs 0-7 should typically be non-zero, while PCRs 8-15 could be filled or not, depending on the EFI bootloader. On Windows, you can run this instead:

```ps1
TpmTool.exe printpcr sha256
```

## The role of Secure Boot

As we have just seen, PCR 7 measures the Secure Boot state. Secure Boot is a UEFI feature that allows to control which EFI binaries (_bootloaders_) are authorized to run. It relies on a hierarchy of keys and certificates. In particular, the `db` database contains a list of certificates which are trusted to sign binaries.

As a general rule, Secure Boot can be enabled or disabled in the UEFI settings, and the keys and certificates can also be managed there. By default, most computers come with Secure Boot enabled, a Platform Key (PK) of the manufacturer, the Key Exchange Key (KEK) of Microsoft, and the `db` database containing at least the Windows UEFI CA 2023 certificate (used to sign the Windows bootloader) and the Microsoft UEFI CA 2023 certificate (used to sign third-party bootloaders, like `shim` used by many Linux distributions).

The main role of Secure Boot is to prevent the execution of _rootkits_, which are low-level malware that can start before the operating system and compromise it. It is also very useful for TPM-based encryption, because if the PCR 7 value matches the one that was present at the time of binding, it means that the certificates used to validate the boot chain have not changed.

It is usually possible to set a UEFI password to prevent the modification of these settings. This is not required for our setup since we will use PCR 7 to bind the key to the Secure Boot configuration. Modifying it would change the PCR 7 value, preventing the TPM from releasing the key.

## An Arch Linux setup using an unified kernel image and PCRs 7 and 11

We are assuming that an Arch Linux system is installed with two partitions: `/dev/nvme0n1p1` as the EFI system partition mounted on `/boot` (which should be at least 1 Go) and `/dev/nvme0n1p2` as the `ext4` root partition, encrypted with LUKS. At this point, Secure Boot should be disabled since Arch does not provide signed bootloaders by default.

By using a [unified kernel image](https://wiki.archlinux.org/title/Unified_kernel_image) (UKI), it is possible to embed the bootloader, the kernel, and the initramfs into a single EFI binary. This binary can then be signed by a custom Secure Boot key, which we add to the `db` database. By binding the key to PCR 7, we can ensure that the key is only released if the system boots with our signed UKI.

This is however insufficient. The UKI is signed, but the chain of trust stops there, because the root filesystem is not verified. An attacker could typically use our UKI with their own (unencrypted) root filesystem, login as root (because they know the password), and from there make a request to the TPM, which would release the LUKS key because PCR 7 matches. To prevent this kind of _disk swapping_ attack, we want to ensure that the key only gets released during the early boot process, before the root filesystem is mounted. For that, we can use PCR 11, in which `systemd-stub` (the EFI binary used by UKIs) measures the hash of the UKI, but also the different milestones of the boot process. In particular, we can ensure that we are in boot phase `enter-initrd`, since PCR 11 is extended again when the initramfs is left.

Because the UKI can regularly change (for instance when the kernel is updated), we use a PCR signing policy instead of binding the key to a single PCR 11 value. Thanks to a utility called [`systemd-measure`](https://man.archlinux.org/man/systemd-measure.1), it is possible to precompute the expected PCR 11 value of our UKI in the `enter-initrd` phase, and sign it with a key pair. The public key is then bound to the TPM when enrolling the LUKS key, and the signature is provided by `systemd-stub` when requesting the key.

It is very important to combine PCRs 7 and 11. Remember that PCR 11 is intended for the OS and is still zero when it starts. If an attacker were allowed to boot whatever EFI binary they want, they could simply make the same measurements into PCR 11 as the legitimate system. By using PCR 7, we ensure that only our signed UKIs can request the keys, and we know that these UKIs make correct measurements into PCR 11.

My setup is to use ukify to generate and sign my UKIs, while letting mkinitcpio generate the initramfs. This requires the installation of the `systemd-ukify` package. The mkinitcpio presets should then be modified by (un)commenting the appropriate lines to enable UKI generation. Here is what my `/etc/mkinitcpio.d/linux.preset` file looks like:

```conf
ALL_kver="/boot/vmlinuz-linux"

PRESETS=('default' 'fallback')

default_uki="/boot/EFI/Linux/arch-linux.efi"
default_options="--splash /usr/share/systemd/bootctl/splash-arch.bmp"

fallback_uki="/boot/EFI/Linux/arch-linux-fallback.efi"
fallback_options="-S autodetect"
```

It is also important to have the correct `HOOKS` in `/etc/mkinitcpio.conf`, notably `sd-encrypt` to unlock the LUKS partition:

```conf
HOOKS=(base systemd autodetect microcode modconf kms keyboard sd-vconsole block sd-encrypt filesystems fsck)
```

By running `mkinitcpio -P`, you can check that UKIs are correctly generated. But they are not signed yet! For that, you need to edit the `/etc/kernel/uki.conf` file, which is used by `ukify`:

```conf
[UKI]
SecureBootSigningTool=systemd-sbsign
SecureBootPrivateKey=/etc/kernel/secure-boot-private-key.pem
SecureBootCertificate=/etc/kernel/secure-boot-certificate.pem
SignKernel=true

[PCRSignature:initrd]
PCRPrivateKey=/etc/systemd/tpm2-pcr-private-key-initrd.pem
PCRPublicKey=/etc/systemd/tpm2-pcr-public-key-initrd.pem
Phases=enter-initrd
```

Once this configuration is written, the appropriate keys can be generated using:

```bash
ukify genkey --config /etc/kernel/uki.conf
```

It is then necessary to enroll the Secure Boot certificate in the UEFI `db` variable. The way to do this depends on your firmware. You can use the auto-enrollment feature of systemd-boot by installing it with:

```bash
bootctl install --secure-boot-auto-enroll yes --certificate /etc/kernel/secure-boot-certificate.pem --private-key /etc/kernel/secure-boot-private-key.pem
```

This installs systemd-boot as the boot manager, and adds authenticated variables `PK.auth`, `KEK.auth`, and `db.auth` in the `/boot/loader/keys/auto/` directory on the EFI partition.

If you want to clear all keys and certificates and only enroll your own, you can usually clear all keys in the UEFI settings (which enables the Setup Mode of Secure Boot), and the bootloader will automatically prompt you to enroll your keys. **Be careful and ensure that there is nothing else you need in the `db` database**. For instance, a discrete GPU OpROM might require a specific certificate to be present.

You can also simply add `db.auth` to the existing keys, which is usually feasible without clearing everything from the UEFI settings.

Before enabling Secure Boot, is it necessary to either [add an EFI variable allowing the UKI to be directly booted](https://wiki.archlinux.org/title/Unified_kernel_image#Directly_from_UEFI), or to [sign systemd-boot](https://wiki.archlinux.org/title/Systemd-boot#Signing_for_Secure_Boot) if a bootloader is required.

Once everything is set up and Secure Boot enabled, the TPM can be enrolled with the [`systemd-cryptenroll`](https://man.archlinux.org/man/systemd-cryptenroll.1) command:

```bash
systemd-cryptenroll /dev/nvme0n1p2 --tpm2-device=auto --tpm2-pcrs=7 --tpm2-public-key=/etc/systemd/tpm2-pcr-public-key-initrd.pem
```

There is no need to specify that PCR 11 must be used for our signing policy (`--tpm2-public-key-pcrs=11`) since it is the default behavior when a public key is provided.

After that, it is important to generate a recovery key in case the TPM can no longer be used for whatever reason:

```bash
systemd-cryptenroll /dev/nvme0n1p2 --recovery-key
```

Any former slot with a potentially less secure passphrase can then be removed. Don't forget to backup the recovery key, for instance in a password manager! It may also be helpful to backup the LUKS header, in case it gets corrupted:

```bash
cryptsetup luksHeaderBackup /dev/nvme0n1p2 --header-backup-file /path/to/your/backup.img
```

This header does not contain any secret per se, and can be restored using `cryptsetup luksHeaderRestore`.

## What about Windows?

Windows 11 has two encryption features: Device Encryption available on both Windows 11 Home and Pro, and BitLocker available only on Windows 11 Pro. Device Encryption is actually BitLocker, but with a simplified interface and some limitations. It requires a Microsoft account to be used (to which the recovery key is automatically backed up, accessible at [aka.ms/myrecoverykey](https://aka.ms/myrecoverykey)), and uses PCRs 7 and 11 to protect the key. I don't know exactly what Windows measures into PCR 11, but it likely plays a similar role as on `systemd-stub`, to ensure that the key is only released during the early boot process.

Device Encryption is automatically enabled if the conditions are met, one of them being that nothing in the boot chain is signed by another certificate than the Windows one. In particular, it does not work if Secure Boot is disabled, if a custom bootloader is used or if there is a discrete GPU OpROM signed by another certificate. In theses cases, the “Device Encryption” menu is not even shown in the settings. If you run the app “System Information” as administrator, you should see `PCR7 Configuration: Binding Not Possible`.

In this case, it is still possible to use BitLocker. If the `7, 11` PCR profile can not be used, BitLocker falls back to using PCRs `0, 2, 4, 11` instead. You can see whether you are using the `7, 11` or the `0, 2, 4, 11` profile using the command:

```ps1
manage-bde -protectors -get C:
```

The output should start with something like this, indicating the PCR profile currently in use:

```
BitLocker Drive Encryption: Configuration Tool version 10.0.26100
Copyright (C) 2013 Microsoft Corporation. All rights reserved.

Volume C: []
All Key Protectors

    TPM:
      ID: {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}
      PCR Validation Profile:
        0, 2, 4, 11
```

If you boot Windows through GRUB or systemd-boot or you have a discrete GPU, it is likely that you are using the `0, 2, 4, 11` profile. This configuration is also secure because the hash of your bootloader and OpROMs is bound to the key. However, it is more fragile, since an update of the OpROMs or the systemd-boot EFI binary would change PCR 4. Keep your recovery key handy in this case!
