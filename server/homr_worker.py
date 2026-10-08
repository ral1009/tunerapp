"""Long-running HOMR worker: loads the models once, then parses one image per request.

Runs inside homr's own uv environment (started by server/main.py as
``uvx --with "opencv-python<5" --from homr python homr_worker.py``), so it never imports anything
from this server's venv. Protocol: one JSON object per line on stdin
``{"image": "<path>"}``, one JSON reply per line on stdout ``{"ok": true, "xml": "<path>",
"seconds": float}`` or ``{"ok": false, "error": "..."}``. homr's own progress output goes to stderr.

Two speedups over running ``homr <image>`` once per upload (measured on an 8-staff phone photo,
12-thread CPU, no CUDA: 39 s per upload as a fresh process):

- The models and onnxruntime sessions live in homr's module globals, so a persistent process
  pays the ~9 s of start-up and model loading once instead of on every upload.
- homr parses staves one after another (2.9 s each, 23.5 s for 8). The staves are independent and
  onnxruntime releases the GIL, so they're parsed on a small thread pool here
  (HOMR_PARALLEL_STAVES, default 4). The output is the same list in the same order.
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

import homr.main as homr_main
import homr.staff_parsing as staff_parsing
import onnxruntime as ort

PARALLEL = max(1, int(os.environ.get("HOMR_PARALLEL_STAVES", "4")))


def _parallel_parse_staffs(debug, staffs, image, config, selected_staff=-1):
    # Same structure and results as homr.staff_parsing.parse_staffs, with the per-staff work
    # (dewarp + TrOMR decode) submitted to a pool and collected in the original order.
    staffs = staff_parsing._ensure_same_number_of_staffs(staffs, image)
    number_of_voices = staff_parsing._get_number_of_voices(staffs)
    regions = staff_parsing.StaffRegions(staffs)
    jobs = []
    i = 0
    for voice in range(number_of_voices):
        for staff_index, staff in enumerate([s.staffs[voice] for s in staffs]):
            if not (selected_staff >= 0 and staff_index != selected_staff):
                jobs.append((voice, i, staff))
            i += 1
    with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        results = list(pool.map(lambda job: staff_parsing.parse_staff_image(debug, job[1], job[2], image, regions, config), jobs))
    voices = []
    for voice in range(number_of_voices):
        result_for_voice = []
        for (job_voice, _, _), result_staff in zip(jobs, results):
            if job_voice != voice or len(result_staff) == 0:
                continue
            result_for_voice.extend([*result_staff, staff_parsing.EncodedSymbol("newline")])
        voices.append(staff_parsing.remove_duplicated_symbols(result_for_voice))
    return voices


if PARALLEL > 1:
    # homr keeps ONE TrOMR model in a module global, and its decoder carries per-call state, so
    # two threads sharing it crash inside onnxruntime ("Only OrtValues that are Tensors are
    # convertible to Numpy objects"). Each pool thread gets its own model instance instead,
    # created on its first staff and reused for every later upload.
    import threading

    import homr.staff_parsing_tromr as tromr
    from homr.transformer.staff2score import Staff2Score

    _local = threading.local()

    def _predict_best_thread_local(org_image, staff, config):
        model = getattr(_local, "model", None)
        if model is None:
            _local.limit_threads = True
            try:
                model = _local.model = Staff2Score(config)
            finally:
                _local.limit_threads = False
        result = model.predict(org_image)
        if staff.is_grandstaff:
            return result
        return [r for r in result if r.position != "lower"]

    tromr.predict_best = _predict_best_thread_local
    homr_main.parse_staffs = _parallel_parse_staffs

    # Each onnxruntime session uses every core by default; N parallel copies then fight over the
    # CPU and the whole thing gets slower (measured: 34 s sequential vs 43-46 s with 3-6 threads).
    # Give each per-staff session its share of the cores instead. Only sessions created for those
    # per-thread models are limited: staff detection (segnet) runs alone and keeps every core.
    _InferenceSession = ort.InferenceSession
    _threads_each = max(1, (os.cpu_count() or 4) // PARALLEL)

    def _session_with_thread_share(path, sess_options=None, *args, **kwargs):
        if sess_options is None and getattr(_local, "limit_threads", False):
            sess_options = ort.SessionOptions()
            sess_options.intra_op_num_threads = _threads_each
        return _InferenceSession(path, sess_options, *args, **kwargs)

    ort.InferenceSession = _session_with_thread_share


def _config():
    # Mirrors homr.main.main() with default arguments (no debug, no cache, CPU unless CUDA).
    transformer_gpu = homr_main.cuda_available()
    segnet_gpu = homr_main.cuda_available() or homr_main.coreml_available()
    homr_main.download_weights(segnet_gpu, transformer_gpu, False)
    ort.set_default_logger_severity(3)
    config = homr_main.ProcessingConfig(False, False, False, False, -1, transformer_gpu, segnet_gpu, False)
    return config, homr_main.XmlGeneratorArguments(False, None, None)


def main() -> None:
    config, xml_args = _config()
    print(json.dumps({"ok": True, "ready": True, "parallel": PARALLEL}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            started = time.time()
            homr_main.process_image(request["image"], config, xml_args)
            xml = homr_main.replace_extension(request["image"], ".musicxml")
            print(json.dumps({"ok": True, "xml": xml, "seconds": time.time() - started}), flush=True)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)


if __name__ == "__main__":
    main()
