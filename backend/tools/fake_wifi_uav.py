#!/usr/bin/env python3
"""Loopback test double of a "WiFi UAV" toy drone, for exercising the real-drone link without a drone.

It binds UDP 127.0.0.1:8800 and speaks just enough of the protocol that turbodrone's WiFi-UAV adapters
(used by MedHop's TurbodroneLink) treat it as a drone:

  * after the client's start / frame-request packets it streams `93 01` JPEG fragments of a small test
    picture at about 15 fps (headerless JPEG scan data, exactly as the client expects),
  * every half second it sends a `93 04` MCU status message: 88 00 <fly> <battery> <flags> 00 55,
  * it answers the firmware-version query,
  * it records every packet it receives, so a test can decode the stick bytes and command bits from
    standalone RC packets and from the command embedded in the video frame requests.

It never transmits to anything but the loopback client that contacted it.

    python tools/fake_wifi_uav.py            # run until Ctrl-C, printing what it decodes
"""
from __future__ import annotations

import argparse
import dataclasses
import socket
import threading
import time
from dataclasses import dataclass
from typing import List, Optional, Tuple

import cv2
import numpy as np

HOST = "127.0.0.1"
PORT = 8800
WIDTH, HEIGHT = 640, 360
FRAGMENT_PAYLOAD = 1024
FRAGMENT_HEADER = 56
START_STREAM = b"\xef\x00\x04\x00"
VERSION_QUERY = b"\xef\x20\x06\x00\x01\x65"
VERSION_REPLY = b"\x01\x65FAKE_V1 20240426 (NOFLOW)"

FLAG_TAKEOFF_OR_LAND = 0x01
FLAG_STOP = 0x02
FLAG_CALIBRATION = 0x04

KIND_START = "start"
KIND_VERSION_QUERY = "version_query"
KIND_RC = "rc"                    # standalone control packet from the RC adapter
KIND_REQUEST_A = "request_a"      # video frame request without ack slots
KIND_REQUEST_B = "request_b"      # video frame request with ack slots
KIND_OTHER = "other"


@dataclass(frozen=True)
class Decoded:
    t: float                      # time.monotonic() when the packet arrived
    kind: str
    roll: Optional[int] = None    # stick bytes, 0x80 is neutral
    pitch: Optional[int] = None
    throttle: Optional[int] = None
    yaw: Optional[int] = None
    command: Optional[int] = None  # bit 0x01 takeoff/land toggle, 0x02 emergency stop, 0x04 calibrate
    checksum_ok: Optional[bool] = None
    raw: bytes = b""
    src_port: Optional[int] = None  # the client's UDP source port (a new one after the library reconnects)

    @property
    def sticks(self) -> Optional[Tuple[int, int, int, int]]:
        """(roll, pitch, throttle, yaw) or None for packets that carry no command."""
        if self.roll is None:
            return None
        return (self.roll, self.pitch, self.throttle, self.yaw)

    @property
    def has_command(self) -> bool:
        return self.roll is not None


def decode_packet(packet: bytes, t: float = 0.0) -> Decoded:
    """Classify one packet from the client and pull out the 20-byte extended command, if present.

    Both the standalone RC packet and the video frame requests are `ef 02 <len:u16> 02 02 00 01
    <slots> 00 00 00 <seq:u32> <cmdlen:u16>` followed by the command at offset 18:
    `66 14 R P T Y <command> <headless> 00*10 <xor> 99` (fld variant axis order).
    """
    if packet == START_STREAM:
        return Decoded(t=t, kind=KIND_START, raw=packet)
    if packet == VERSION_QUERY:
        return Decoded(t=t, kind=KIND_VERSION_QUERY, raw=packet)
    if len(packet) < 38 or packet[:2] != b"\xef\x02" or packet[18:20] != b"\x66\x14":
        return Decoded(t=t, kind=KIND_OTHER, raw=packet)
    command = packet[18:38]
    roll, pitch, throttle, yaw, bits, headless = command[2:8]
    checksum = roll ^ pitch ^ throttle ^ yaw ^ bits ^ headless
    slots = packet[8]
    kind = KIND_REQUEST_A if slots == 0 else KIND_REQUEST_B
    if len(packet) == 124 and slots == 2:
        # The RC adapter's packet has the same shape as a two-slot request, but its three rolling
        # counters are consecutive: seq, seq + 1, seq + 2.
        seq = int.from_bytes(packet[12:14], "little")
        ctr2 = int.from_bytes(packet[88:90], "little")
        ctr3 = int.from_bytes(packet[108:110], "little")
        if ctr2 == (seq + 1) & 0xFFFF and ctr3 == (seq + 2) & 0xFFFF:
            kind = KIND_RC
    return Decoded(
        t=t, kind=kind, roll=roll, pitch=pitch, throttle=throttle, yaw=yaw, command=bits,
        checksum_ok=(checksum == command[18] and command[19] == 0x99), raw=packet,
    )


def build_mcu_packet(message: bytes, seq: int = 0) -> bytes:
    total = 12 + len(message)
    return (
        b"\x93\x04" + total.to_bytes(2, "little") + (seq & 0xFFFFFFFF).to_bytes(4, "little")
        + len(message).to_bytes(2, "little") + b"\x00\x00" + message
    )


def build_status_message(fly_state: int, battery: int, flags: int) -> bytes:
    return bytes([0x88, 0x00, fly_state & 0xFF, battery & 0xFF, flags & 0xFF, 0x00, 0x55])


def jpeg_scan_data(image: np.ndarray) -> bytes:
    """Entropy-coded scan of a baseline 4:4:4 quality-50 JPEG, without headers and without EOI.

    The client prepends its own SOI/DQT/SOF0/SOS header (standard tables, no Huffman tables) and
    appends EOI, so only the scan bytes travel in the fragments.
    """
    ok, encoded = cv2.imencode(".jpg", image, [
        cv2.IMWRITE_JPEG_QUALITY, 50,
        cv2.IMWRITE_JPEG_SAMPLING_FACTOR, cv2.IMWRITE_JPEG_SAMPLING_FACTOR_444,
    ])
    if not ok:
        raise RuntimeError("JPEG encoding failed")
    data = encoded.tobytes()
    index = 2
    while index < len(data):
        if data[index] != 0xFF:
            raise RuntimeError("unexpected JPEG structure")
        marker = data[index + 1]
        length = int.from_bytes(data[index + 2:index + 4], "big")
        if marker == 0xDA:
            return data[index + 2 + length:-2]
        index += 2 + length
    raise RuntimeError("no scan found in the JPEG")


def build_fragments(frame_id: int, scan: bytes) -> List[bytes]:
    chunks = [scan[i:i + FRAGMENT_PAYLOAD] for i in range(0, len(scan), FRAGMENT_PAYLOAD)] or [b""]
    packets = []
    for index, chunk in enumerate(chunks):
        header = bytearray(FRAGMENT_HEADER)
        header[0], header[1] = 0x93, 0x01
        header[2:4] = (FRAGMENT_HEADER + len(chunk)).to_bytes(2, "little")
        header[8:16] = frame_id.to_bytes(8, "little")
        header[32:36] = index.to_bytes(4, "little")
        header[36:40] = len(chunks).to_bytes(4, "little")
        header[40:44] = len(scan).to_bytes(4, "little")
        header[48] = 50
        packets.append(bytes(header) + chunk)
    return packets


def test_picture(frame_id: int, marker_id: Optional[int] = 7, marker_dx: int = 0) -> np.ndarray:
    """640x360 test card: light wall, optional small station marker, a moving bar and the frame number.

    `marker_dx` moves the marker sideways from the middle of the picture (pixels, + is right).
    """
    image = np.full((HEIGHT, WIDTH, 3), 205, np.uint8)
    cv2.rectangle(image, (0, 300), (WIDTH, HEIGHT), (120, 135, 150), -1)
    if marker_id is not None:
        dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
        marker = cv2.aruco.generateImageMarker(dictionary, int(marker_id), 40)
        left = max(0, min(WIDTH - 60, 290 + int(marker_dx)))
        image[136:196, left:left + 60] = 255
        image[146:186, left + 10:left + 50] = marker[..., None]
    x = 20 + (frame_id * 6) % 560
    cv2.rectangle(image, (x, 320), (x + 40, 340), (40, 60, 200), -1)
    cv2.putText(image, f"FAKE DRONE {frame_id:06d}", (16, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (30, 30, 30), 2)
    return image


class FakeWifiUav:
    def __init__(self, host: str = HOST, port: int = PORT, fps: float = 15.0,
                 marker_id: Optional[int] = 7) -> None:
        if host not in ("127.0.0.1", "localhost"):
            raise ValueError("the fake drone only ever binds to the loopback interface")
        self.host, self.port, self.fps, self.marker_id = host, port, fps, marker_id
        self.fly_state, self.battery, self.flags = 1, 42, 16
        self._sock: Optional[socket.socket] = None
        self._lock = threading.Lock()
        self._stop_evt = threading.Event()
        self._threads: List[threading.Thread] = []
        self._packets: List[Decoded] = []
        self._client: Optional[Tuple[str, int]] = None
        self._last_request = 0.0
        self._video_paused_until = 0.0
        self._telemetry_enabled = True
        self._marker_dx = 0.0             # where the marker is drawn, pixels from the middle
        self._marker_px_per_s = 0.0       # ... and how fast it slides (as if the drone drifted sideways)
        self._marker_at = time.monotonic()
        self._frame_id = 0
        self.frames_sent = 0

    # ------------------------------------------------------------------ #
    def start(self) -> "FakeWifiUav":
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((self.host, self.port))
        sock.settimeout(0.2)
        self._sock = sock
        self._stop_evt.clear()
        for target, name in ((self._rx_loop, "fake-uav-rx"), (self._tx_loop, "fake-uav-tx")):
            thread = threading.Thread(target=target, name=name, daemon=True)
            thread.start()
            self._threads.append(thread)
        return self

    def stop(self) -> None:
        self._stop_evt.set()
        for thread in self._threads:
            thread.join(timeout=2.0)
        self._threads = []
        if self._sock is not None:
            self._sock.close()
            self._sock = None

    def __enter__(self) -> "FakeWifiUav":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()

    # ------------------------------------------------------------------ #
    # test controls
    # ------------------------------------------------------------------ #
    def pause_video(self, seconds: float) -> None:
        """Stop sending video (the status messages continue) for this long. The library closes its
        socket after 4 s without a video packet (status messages do not count) and reopens it about
        5 s later, from a new source port."""
        with self._lock:
            self._video_paused_until = time.monotonic() + seconds

    def slide_marker(self, px_per_s: float = 0.0, reset: bool = False) -> None:
        """Make the marker in the test picture slide sideways at `px_per_s` (+ is right), as it
        would for a drone that drifts the other way. `reset` puts it back in the middle first."""
        with self._lock:
            self._marker_dx = 0.0 if reset else self._marker_offset_locked(time.monotonic())
            self._marker_at = time.monotonic()
            self._marker_px_per_s = float(px_per_s)

    def _marker_offset_locked(self, now: float) -> float:
        return self._marker_dx + self._marker_px_per_s * (now - self._marker_at)

    def set_status(self, fly_state: Optional[int] = None, battery: Optional[int] = None,
                   flags: Optional[int] = None) -> None:
        with self._lock:
            if fly_state is not None:
                self.fly_state = fly_state
            if battery is not None:
                self.battery = battery
            if flags is not None:
                self.flags = flags

    def packets(self, since: float = 0.0, kinds: Optional[Tuple[str, ...]] = None) -> List[Decoded]:
        """Every packet received at or after `since` (time.monotonic()), oldest first."""
        with self._lock:
            return [p for p in self._packets if p.t >= since and (kinds is None or p.kind in kinds)]

    def commands(self, since: float = 0.0, kinds: Optional[Tuple[str, ...]] = None) -> List[Decoded]:
        """Only packets that carry stick bytes and command bits."""
        return [p for p in self.packets(since, kinds) if p.has_command]

    def bit_times(self, bit: int, since: float = 0.0) -> List[float]:
        """Arrival times (time.monotonic()) of every command packet with `bit` set in its command byte."""
        return [p.t for p in self.commands(since) if p.command & bit]

    def source_ports(self, since: float = 0.0) -> List[Tuple[float, int]]:
        """(time of the first packet, source port) for each client source port seen, oldest first."""
        seen: List[Tuple[float, int]] = []
        for p in self.packets(since):
            if p.src_port is not None and all(port != p.src_port for _t, port in seen):
                seen.append((p.t, p.src_port))
        return seen

    def clear(self) -> None:
        with self._lock:
            self._packets = []

    # ------------------------------------------------------------------ #
    def _rx_loop(self) -> None:
        while not self._stop_evt.is_set():
            try:
                packet, address = self._sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                break
            if address[0] != "127.0.0.1":
                continue   # never talk to anything but loopback
            now = time.monotonic()
            decoded = dataclasses.replace(decode_packet(packet, now), src_port=address[1])
            with self._lock:
                self._packets.append(decoded)
                self._client = address
                if decoded.kind in (KIND_START, KIND_REQUEST_A, KIND_REQUEST_B):
                    self._last_request = now
            if decoded.kind == KIND_VERSION_QUERY:
                self._send(build_mcu_packet(VERSION_REPLY), address)

    def _send(self, packet: bytes, address: Tuple[str, int]) -> None:
        try:
            self._sock.sendto(packet, address)
        except OSError:
            pass

    def _tx_loop(self) -> None:
        period = 1.0 / self.fps
        next_frame = time.monotonic()
        next_status = time.monotonic()
        status_seq = 0
        while not self._stop_evt.is_set():
            now = time.monotonic()
            with self._lock:
                client = self._client
                requested = (now - self._last_request) < 1.0   # a real drone stops unless asked for frames
                paused = now < self._video_paused_until
                status = build_status_message(self.fly_state, self.battery, self.flags)
                marker_dx = int(round(self._marker_offset_locked(now)))
            if client is not None and now >= next_status:
                next_status = now + 0.5
                status_seq += 1
                if self._telemetry_enabled:
                    self._send(build_mcu_packet(status, status_seq), client)
            if now >= next_frame:
                next_frame = max(next_frame + period, now - period)
                if client is not None and requested and not paused:
                    self._frame_id += 1
                    scan = jpeg_scan_data(test_picture(self._frame_id, self.marker_id, marker_dx))
                    for fragment in build_fragments(self._frame_id, scan):
                        self._send(fragment, client)
                    self.frames_sent += 1
            self._stop_evt.wait(0.004)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--fps", type=float, default=15.0)
    parser.add_argument("--no-marker", action="store_true", help="test picture without the station marker")
    args = parser.parse_args()
    drone = FakeWifiUav(port=args.port, fps=args.fps, marker_id=None if args.no_marker else 7).start()
    print(f"fake WiFi-UAV drone listening on udp://{HOST}:{args.port} (Ctrl-C to stop)")
    last = None
    try:
        while True:
            time.sleep(0.25)
            commands = drone.commands()
            drone.clear()
            if not commands:
                continue
            newest = commands[-1]
            state = (newest.sticks, newest.command)
            if state != last:
                last = state
                r, p, t, y = newest.sticks
                print(f"sticks R:{r:#04x} P:{p:#04x} T:{t:#04x} Y:{y:#04x} command:{newest.command:#04x} "
                      f"({newest.kind}, frames sent {drone.frames_sent})")
    except KeyboardInterrupt:
        pass
    finally:
        drone.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
