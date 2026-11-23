use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser, Debug, Clone, Default)]
#[command(
    name = "vaakora",
    about = concat!(env!("BRAND_DISPLAY_NAME"), " - Speech to Text"),
    args_conflicts_with_subcommands = true
)]
pub struct CliArgs {
    /// Control the running app from the command line (never starts it)
    #[command(subcommand)]
    pub command: Option<Command>,

    /// Start with the main window hidden
    #[arg(long)]
    pub start_hidden: bool,

    /// Disable the system tray icon
    #[arg(long)]
    pub no_tray: bool,

    /// Toggle transcription on/off (sent to running instance)
    #[arg(long)]
    pub toggle_transcription: bool,

    /// Toggle transcription with post-processing on/off (sent to running instance)
    #[arg(long)]
    pub toggle_post_process: bool,

    /// Cancel the current operation (sent to running instance)
    #[arg(long)]
    pub cancel: bool,

    /// Enable debug mode with verbose logging
    #[arg(long)]
    pub debug: bool,

    /// Transcribe this WAV (16 kHz mono) headlessly and exit. Runs the same
    /// batch transcription path as the app — no mic, no silence removal, no
    /// download (the model must already be installed). Long audio is still
    /// chunked at pauses, as in the app.
    #[arg(short = 'f', long, value_name = "WAV")]
    pub transcribe_file: Option<PathBuf>,

    /// Model id to load for --transcribe-file (default: the selected model).
    #[arg(long)]
    pub model: Option<String>,

    /// Hard-select the compute device for --transcribe-file by its registry
    /// index (see --list-devices). Omit to use the persisted accelerator
    /// setting. transcribe-cpp (whisper-family) models only.
    #[arg(long, value_name = "N")]
    pub device_index: Option<usize>,

    /// List the transcribe-cpp compute devices (with indices) and exit.
    #[arg(long)]
    pub list_devices: bool,

    /// List the available models (with ids) and exit. Pass an id to --model.
    /// Honors --json for machine-readable output.
    #[arg(long)]
    pub list_models: bool,

    /// Repeat the transcription N times (best_ms reports the fastest run).
    #[arg(long, value_name = "N")]
    pub repeat: Option<usize>,

    /// Emit --transcribe-file results as JSON.
    #[arg(long)]
    pub json: bool,
}

/// Commands that talk to the running app through its control socket. The text
/// to read is only ever a file or piped input: argv is readable by every
/// process of the machine, so no option takes the text itself.
#[derive(Subcommand, Debug, Clone, PartialEq)]
pub enum Command {
    /// Read a file, or text piped in (`-` or no file), aloud
    Read { path: Option<PathBuf> },
    /// Pause the reader
    Pause,
    /// Resume a paused read
    Resume,
    /// Stop reading and close the reader
    Stop,
    /// Show what the app is doing
    Status {
        /// Print the raw result as JSON
        #[arg(long)]
        json: bool,
    },
    /// List the downloaded voices
    Voices {
        /// Print the raw result as JSON
        #[arg(long)]
        json: bool,
    },
    /// Start or stop a dictation, or cancel it
    Dictate {
        /// Post-process the transcript, as the post-processing shortcut does
        #[arg(long)]
        post_process: bool,
        /// Cancel the current dictation
        #[arg(long, conflicts_with = "post_process")]
        cancel: bool,
    },
    /// Transcribe an audio file and print its text
    Transcribe {
        path: PathBuf,
        /// Print the raw result as JSON
        #[arg(long)]
        json: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<CliArgs, clap::Error> {
        CliArgs::try_parse_from(args)
    }

    fn command(args: &[&str]) -> Command {
        parse(args).unwrap().command.expect("a subcommand")
    }

    #[test]
    fn subcommands_parse() {
        assert_eq!(
            command(&["vaakora", "read", "-"]),
            Command::Read {
                path: Some(PathBuf::from("-"))
            }
        );
        assert_eq!(command(&["vaakora", "read"]), Command::Read { path: None });
        assert_eq!(command(&["vaakora", "pause"]), Command::Pause);
        assert_eq!(command(&["vaakora", "resume"]), Command::Resume);
        assert_eq!(command(&["vaakora", "stop"]), Command::Stop);
        assert_eq!(
            command(&["vaakora", "status"]),
            Command::Status { json: false }
        );
        assert_eq!(
            command(&["vaakora", "status", "--json"]),
            Command::Status { json: true }
        );
        assert_eq!(
            command(&["vaakora", "voices", "--json"]),
            Command::Voices { json: true }
        );
        assert_eq!(
            command(&["vaakora", "dictate"]),
            Command::Dictate {
                post_process: false,
                cancel: false
            }
        );
        assert_eq!(
            command(&["vaakora", "dictate", "--post-process"]),
            Command::Dictate {
                post_process: true,
                cancel: false
            }
        );
        assert_eq!(
            command(&["vaakora", "dictate", "--cancel"]),
            Command::Dictate {
                post_process: false,
                cancel: true
            }
        );
        assert_eq!(
            command(&["vaakora", "transcribe", "a.wav", "--json"]),
            Command::Transcribe {
                path: PathBuf::from("a.wav"),
                json: true
            }
        );
    }

    #[test]
    fn flags_still_parse() {
        let args = parse(&["vaakora", "--start-hidden"]).unwrap();
        assert!(args.command.is_none());
        assert!(args.start_hidden);

        let args = parse(&["vaakora"]).unwrap();
        assert!(args.command.is_none());
        assert!(!args.cancel && !args.start_hidden);

        let args = parse(&[
            "vaakora",
            "--no-tray",
            "--toggle-transcription",
            "--toggle-post-process",
            "--cancel",
            "--debug",
            "--transcribe-file",
            "a.wav",
            "--model",
            "m",
            "--device-index",
            "2",
            "--list-devices",
            "--list-models",
            "--repeat",
            "3",
            "--json",
        ])
        .unwrap();
        assert!(args.command.is_none());
        assert!(args.no_tray && args.toggle_transcription && args.toggle_post_process);
        assert!(args.cancel && args.debug && args.list_devices && args.list_models && args.json);
        assert_eq!(args.transcribe_file, Some(PathBuf::from("a.wav")));
        assert_eq!(args.model.as_deref(), Some("m"));
        assert_eq!((args.device_index, args.repeat), (Some(2), Some(3)));

        // The old flag and the dictate subcommand's option are different things.
        let args = parse(&["vaakora", "--cancel"]).unwrap();
        assert!(args.cancel && args.command.is_none());
    }

    #[test]
    fn flag_with_subcommand_is_refused() {
        assert!(parse(&["vaakora", "--start-hidden", "status"]).is_err());
        assert!(parse(&["vaakora", "--cancel", "stop"]).is_err());
    }

    #[test]
    fn read_has_no_text_option() {
        assert!(parse(&["vaakora", "read", "--text", "x"]).is_err());
        assert!(parse(&["vaakora", "read", "a.txt", "b.txt"]).is_err());
    }

    #[test]
    fn dictate_flags_conflict() {
        assert!(parse(&["vaakora", "dictate", "--post-process", "--cancel"]).is_err());
    }

    #[test]
    fn every_subcommand_has_help_text() {
        let cmd = <CliArgs as clap::CommandFactory>::command();
        let names: Vec<&str> = cmd.get_subcommands().map(|c| c.get_name()).collect();
        assert_eq!(
            names,
            [
                "read",
                "pause",
                "resume",
                "stop",
                "status",
                "voices",
                "dictate",
                "transcribe"
            ]
        );
        for sub in cmd.get_subcommands() {
            assert!(
                sub.get_about().is_some(),
                "{} has no help text",
                sub.get_name()
            );
        }
    }
}
