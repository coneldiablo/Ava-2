"""Static safety contract for the guarded backend tokenizer-cache image."""
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = ROOT / "native_modules/onyx/auth/Dockerfile.tokenizer"


class OnyxTokenizerImageTests(unittest.TestCase):
    def source(self) -> str:
        return DOCKERFILE.read_text(encoding="utf-8")

    def test_bases_and_model_revision_are_exactly_pinned(self):
        source = self.source()
        self.assertIn("ONYX_HTTP_IMAGE=ava-onyx-http@sha256:797105ac28eb6d9826850e473c97d321bc1a52f8517ba64ef2d8a54d19f5452c", source)
        self.assertIn("ONYX_MODEL_IMAGE=onyxdotapp/onyx-model-server@sha256:2e1eecb40c47814713afb2a10b0d3217dd6d47db22f7083738283e9d6f089f61", source)
        self.assertIn('revision = "3ac47f125a41961d13b397d0332866be2f9152e1"', source)
        self.assertEqual(len(re.findall(r"^FROM ", source, re.MULTILINE)), 2)
        first = source.split('FROM ${ONYX_HTTP_IMAGE}', 1)[0]
        self.assertIn('SHELL ["python", "-c"]', first)
        self.assertIn("RUN <<'PY'", first)

    def test_copy_is_tokenizer_only_and_never_copies_weight_tree(self):
        source = self.source()
        self.assertIn('"tokenizer.json"', source)
        self.assertIn('"1_Pooling/config.json"', source)
        self.assertIn("COPY --from=tokenizer_source --chown=1001:1001 /tmp/ava-tokenizer-cache/", source)
        for forbidden in ("model.safetensors", "pytorch_model.bin", "*.bin", "*.safetensors"):
            self.assertNotIn(forbidden, source)
        self.assertNotIn("COPY --from=tokenizer_source /app/.cache/temp_huggingface", source)

    def test_source_dereference_is_confined_and_revision_ref_is_verified(self):
        source = self.source()
        self.assertIn("plain_directory(parent)", source)
        self.assertIn('resolved.relative_to(model / "blobs")', source)
        self.assertIn("stat.S_ISLNK(info.st_mode)", source)
        self.assertIn("reference.read_text", source)
        self.assertIn('.write_text(revision, encoding="ascii")', source)
        self.assertIn("resolved_info.st_size <= 64 * 1024 * 1024", source)
        self.assertIn('if "tokenizer.json" not in copied', source)

    def test_final_image_preserves_guard_nonroot_and_offline_smoke(self):
        source = self.source()
        final = source.split("FROM ${ONYX_HTTP_IMAGE}", 1)[1]
        self.assertIn("HF_HOME=/app/.cache/huggingface", final)
        self.assertIn("HF_HUB_OFFLINE=1", final)
        self.assertIn("TRANSFORMERS_OFFLINE=1", final)
        self.assertIn("AVA_NATIVE_HTTP_GUARD=true", final)
        self.assertRegex(final, r"USER 1001\s+RUN python - <<'PY'")
        self.assertIn('Tokenizer.from_pretrained("nomic-ai/nomic-embed-text-v1")', final)
        self.assertNotRegex(source.lower(), r"\b(?:curl|wget|git clone|pip install|uv pip)\b")
        self.assertNotIn("COPY onyx", final)
        self.assertIn('COPY --chown=0:0 native_modules/onyx/auth/core.py /app/onyx/ava_auth/core.py', final)
        self.assertIn('COPY --chown=0:0 native_modules/onyx/auth/app.py /app/onyx/ava_auth/app.py', final)
        self.assertIn('chown 1001:1001 /var/lib/ava-auth', final)
        self.assertIn('chmod 0700 /var/lib/ava-auth', final)


if __name__ == "__main__": unittest.main()
