## 2026.10.14.1

**Fixed:** Methods that write a singleton resource failed on current swamp with
`Data name 'latest' is reserved for internal use`.

**Changed:** Singleton get and action methods now write their data under
`create_downloads-current`, `create_signing_keys-current`,
`create_type_specific_downloads-current`, `list_live_inputs-current`,
`stream_live_inputs_disable_a_live_input-current`,
`stream_live_inputs_enable_a_live_input-current`,
`stream_live_inputs_rotate_keys_for_a_live_input-current`,
`stream_subtitles_captions_generate_caption_or_subtitle_for_language-current`,
`stream_videos_initiate_video_uploads_using_tus-current`,
`stream_videos_storage_usage-current`, `stream_webhook_view_webhooks-current`,
`update_video_details-current` instead of `latest`. Anything that read
`data.latest("<model>", "latest")` or queried `name == "latest"` must use the
new name.

**Upgrade note:** Data previously stored under `latest` is not migrated; re-run
the method to populate the new name. No attribute schemas changed.
