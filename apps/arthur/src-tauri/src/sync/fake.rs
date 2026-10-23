use super::protocol::*;
use std::{cell::RefCell, collections::VecDeque, rc::Rc};
#[derive(Default)]
pub(super) struct Link {
    pub online: bool,
    pub queues: [VecDeque<Message>; 2],
    pub lose_receipt: usize,
    pub duplicate: bool,
    pub drop_chunk: Option<usize>,
}
pub(super) struct FakeTransport {
    pub link: Rc<RefCell<Link>>,
    pub side: usize,
    pub binding: PeerHello,
}
impl FakeTransport {
    pub fn pair(a: PeerHello, b: PeerHello) -> (Self, Self, Rc<RefCell<Link>>) {
        let link = Rc::new(RefCell::new(Link {
            online: true,
            ..Link::default()
        }));
        (
            Self {
                link: link.clone(),
                side: 0,
                binding: a,
            },
            Self {
                link: link.clone(),
                side: 1,
                binding: b,
            },
            link,
        )
    }
}
impl AuthenticatedTransport for FakeTransport {
    fn hello(&self) -> PeerHello {
        self.binding.clone()
    }
    fn send(&mut self, message: Message) -> Result<()> {
        match &message.payload {
            Payload::Hello { profile, .. } if profile.len() > 64 => return Err(Error::Limit),
            Payload::Summary(s)
                if s.known.len() > SUMMARY_PAGE || s.progress.len() > MAX_EVENTS =>
            {
                return Err(Error::Limit)
            }
            Payload::Request(ids) if ids.len() > 32 => return Err(Error::Limit),
            _ => {}
        }
        let mut link = self.link.borrow_mut();
        if !link.online {
            return Err(Error::Disconnected);
        }
        if matches!(message.payload, Payload::Receipt(_)) && link.lose_receipt > 0 {
            link.lose_receipt -= 1;
            return Ok(());
        }
        if matches!(&message.payload,Payload::Chunk(c) if Some(c.index)==link.drop_chunk) {
            return Ok(());
        }
        if let Payload::Chunk(c) = &message.payload {
            if c.bytes.len() > MAX_FRAME {
                return Err(Error::Limit);
            }
        }
        let duplicate = link.duplicate;
        link.duplicate = false;
        let q = &mut link.queues[1 - self.side];
        if q.len() + 1 + usize::from(duplicate) > 64 {
            return Err(Error::Limit);
        }
        if duplicate {
            q.push_back(message.clone())
        }
        q.push_back(message);
        Ok(())
    }
    fn receive(&mut self) -> Result<Option<Message>> {
        let mut link = self.link.borrow_mut();
        if !link.online {
            return Err(Error::Disconnected);
        }
        Ok(link.queues[self.side].pop_front())
    }
}
