import json

from vitrus.droid import Droid


class FakeSubscriber:
    def __init__(self):
        self.closed = False

    def undeclare(self):
        self.closed = True


class FakeSession:
    def __init__(self):
        self.topic = None
        self.callback = None
        self.subscriber = FakeSubscriber()

    def declare_subscriber(self, topic, callback):
        self.topic = topic
        self.callback = callback
        return self.subscriber


def test_multiple_clients_can_subscribe_without_motor_polling():
    first_session = FakeSession()
    second_session = FakeSession()
    first = Droid("R-06", "key", zenoh_session=first_session)
    second = Droid("R-06", "key", zenoh_session=second_session)
    received = []

    first_subscription = first.subscribe_telemetry(received.append)
    second_subscription = second.subscribe_telemetry(received.append)

    payload = json.dumps({"schema": "vitrus.telemetry.state.v1", "joints": {"NECK_HEAD": {"display_deg": 1}}})
    first_session.callback(type("Sample", (), {"payload": payload.encode()})())
    second_session.callback(type("Sample", (), {"payload": payload.encode()})())

    assert first_session.topic == "vitrus/state/motor_state"
    assert second_session.topic == "vitrus/state/motor_state"
    assert len(received) == 2
    first_subscription.close()
    second_subscription.close()
    assert first_session.subscriber.closed is True
    assert second_session.subscriber.closed is True