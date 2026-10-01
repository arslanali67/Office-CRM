<?php

namespace Espo\Modules\OfficeAutomation\Hooks\SocialMessage;

use Espo\ORM\Entity;
use Espo\ORM\EntityManager;
use Espo\ORM\Repository\Option\SaveOptions;

/** A message belongs to whoever its conversation is assigned to (drives "own" access for employees). */
class SyncAssignee
{
    public static int $order = 5;

    public function __construct(private EntityManager $entityManager) {}

    public function beforeSave(Entity $entity, array $options): void
    {
        if (!$entity->isNew()) {
            return;
        }

        $conversation = $this->entityManager->getEntityById('Conversation', (string) $entity->get('conversationId'));
        $entity->set('assignedUserId', $conversation?->get('assignedUserId'));
    }
}
