<?php

namespace Espo\Modules\OfficeAutomation\Tools\Email;

use Espo\Core\Acl;
use Espo\Core\Exceptions\BadRequest;
use Espo\Core\Exceptions\Conflict;
use Espo\Core\Exceptions\Forbidden;
use Espo\Core\Exceptions\NotFound;
use Espo\Entities\Email;
use Espo\Entities\User;
use Espo\ORM\Entity;
use Espo\ORM\EntityManager;
use Espo\Tools\Email\SendService;

/**
 * Sends the reply to an inbound email through the group mailbox, threaded to the original.
 * Used by the "Send AI draft" button (a person) and by the automation service (API user).
 */
class AiReplyService
{
    public function __construct(
        private EntityManager $entityManager,
        private Acl $acl,
        private User $user,
        private SendService $sendService
    ) {}

    /** @throws BadRequest @throws Forbidden @throws NotFound @throws Conflict */
    public function send(string $emailId, ?string $body): Entity
    {
        $orig = $this->entityManager->getEntityById(Email::ENTITY_TYPE, $emailId) ?? throw new NotFound();

        if (!$this->acl->checkEntityRead($orig) || !$this->acl->checkScope('Email', 'create')) {
            throw new Forbidden();
        }
        if (in_array($orig->get('aiStatus'), ['sent', 'auto_replied'], true)) {
            throw new Conflict('This message has already been answered.');
        }

        $text = trim($body ?? (string) $orig->get('aiDraft'));
        if ($text === '') {
            throw new BadRequest('The reply is empty.');
        }

        $from = $this->findFromAddress($orig) ?? throw new BadRequest('No group email account with SMTP to send from.');
        $name = (string) $orig->get('name');

        $reply = $this->entityManager->createEntity('Email', [
            'name' => preg_match('/^re:/i', $name) ? $name : 'Re: ' . $name,
            'body' => $text,
            'isHtml' => false,
            'status' => 'Sending',
            'from' => $from,
            'to' => $orig->getFromAddress() ?? throw new BadRequest('The message has no sender address.'),
            'repliedId' => $orig->getId(),
            'parentType' => $orig->get('parentType'),
            'parentId' => $orig->get('parentId'),
        ]);

        // null user: send through the group account, not a personal one.
        $this->sendService->send($reply, null);

        // KPI "AI replies corrected by a human": a person sent a reply that differs from what the AI first wrote.
        $original = (string) $orig->get('aiDraftOriginal');
        if (!$this->user->isApi() && $original !== '') {
            $norm = fn (string $s) => preg_replace('/\s+/', ' ', trim($s));
            $orig->set('aiEdited', $norm($text) !== $norm($original));
        }

        $orig->set('aiStatus', $this->user->isApi() ? 'auto_replied' : 'sent');
        $this->entityManager->saveEntity($orig);

        return $reply;
    }

    /**
     * @return string[]
     * @throws Forbidden
     */
    public function ownAddresses(): array
    {
        if (!$this->user->isApi()) {
            throw new Forbidden();
        }

        $list = [];
        foreach ($this->entityManager->getRDBRepository('InboundEmail')->find() as $account) {
            $list[] = $account->get('emailAddress');
        }
        foreach ($this->entityManager->getRDBRepository(User::ENTITY_TYPE)->where(['isActive' => true])->find() as $user) {
            $list[] = $user->get('emailAddress');
        }

        return array_values(array_unique(array_map('strtolower', array_filter($list))));
    }

    private function findFromAddress(Email $orig): ?string
    {
        $recipients = array_map('strtolower', [...$orig->getToAddressList(), ...$orig->getCcAddressList()]);

        $accounts = $this->entityManager->getRDBRepository('InboundEmail')
            ->where(['status' => 'Active', 'useSmtp' => true])->find();

        $first = null;
        foreach ($accounts as $account) {
            $address = (string) $account->get('emailAddress');
            $first ??= $address;
            if (in_array(strtolower($address), $recipients, true)) {
                return $address;
            }
        }

        return $first;
    }
}
